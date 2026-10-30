// Deterministic workload engine. No LLM, no I/O: pure functions of (orders, settings, now).
//
// Scheduling assumptions (also documented in server/README.md):
//  1. Only OPEN orders (pending, confirmed, in_progress) count. completed/cancelled are always excluded.
//  2. Pending workload = sum of prepTimeMinutes of open orders that have a prep time. prepTimeMinutes is the TOTAL
//     for the order (quantity is not multiplied again).
//  3. Orders missing prepTimeMinutes and/or deadline cannot be scheduled; they are reported as unscheduled, never guessed.
//  4. Capacity per working day = min(dailyCapacityMinutes, working-window length). Non-working days have 0.
//     Today's capacity is further limited to the time left in today's window.
//  5. Scheduling is earliest-deadline-first (ties: shorter job, then id). Work is placed contiguously from the start of
//     each day's window, splitting across days when a day fills up. Breaks are not modelled separately.
//  6. Risk: high = deadline passed, cannot finish inside the horizon, or finish time is after the deadline;
//     medium = finish time is less than riskBufferMinutes before the deadline; low = otherwise.
import { zonedParts, zonedTimeToUtc, addDays, weekdayOf, ymdString, parseHm, formatInZone } from '../utils/timezone.js';
import { OPEN_STATUSES, validateOrderInput } from '../utils/validation.js';
import { ApiError } from '../utils/errors.js';

const MIN = 60000;
export const HORIZON_DAYS = 60;
export const NEAR_WORKING_DAYS = 2;

export function buildCapacityDays({ now, settings, count = HORIZON_DAYS }) {
  const tz = settings.timezone;
  const t = zonedParts(now, tz);
  const startYmd = { year: t.year, month: t.month, day: t.day };
  const days = [];
  for (let i = 0; i < count; i++) {
    const ymd = addDays(startYmd, i);
    const working = settings.workingDays.includes(weekdayOf(ymd));
    const ws = zonedTimeToUtc({ ...ymd, ...parseHm(settings.workStart) }, tz);
    const we = zonedTimeToUtc({ ...ymd, ...parseHm(settings.workEnd) }, tz);
    let capacity = working ? Math.min(settings.dailyCapacityMinutes, Math.max(0, Math.floor((we - ws) / MIN))) : 0;
    let start = ws;
    if (i === 0 && working) {
      start = now > ws ? now : ws;
      capacity = Math.min(capacity, Math.max(0, Math.floor((we - start) / MIN)));
    }
    days.push({ date: ymdString(ymd), capacityMinutes: capacity, plannedMinutes: 0, start, orders: [] });
  }
  return days;
}

export function normalizeOrder(o) {
  return {
    id: String(o.id ?? o._id),
    customerName: o.customerName,
    item: o.item,
    quantity: o.quantity ?? 1,
    status: o.status,
    paymentStatus: o.paymentStatus ?? 'unverified',
    prepTimeMinutes: o.prepTimeMinutes ?? null,
    deadline: o.deadline ? new Date(o.deadline) : null,
  };
}

const fmtDur = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`);
const RANK = { high: 0, medium: 1, low: 2 };

export function computePlan({ orders, settings, now = new Date(), rangeDays = 7 }) {
  const tz = settings.timezone;
  const open = orders.map(normalizeOrder).filter((o) => OPEN_STATUSES.includes(o.status));
  const days = buildCapacityDays({ now, settings });

  const unscheduledOrders = [];
  const plannable = [];
  for (const o of open) {
    const noPrep = o.prepTimeMinutes === null;
    const noDeadline = o.deadline === null;
    if (noPrep || noDeadline) unscheduledOrders.push({ id: o.id, reason: noPrep && noDeadline ? 'missing_both' : noPrep ? 'missing_prep_time' : 'missing_deadline' });
    else plannable.push(o);
  }
  plannable.sort((a, b) => a.deadline - b.deadline || a.prepTimeMinutes - b.prepTimeMinutes || a.id.localeCompare(b.id));

  const results = {};
  const schedule = [];
  const queued = []; // orders already placed (earliest deadline first), used to explain what is ahead of each order
  for (const o of plannable) {
    let remaining = o.prepTimeMinutes;
    let firstStart = null;
    let lastEnd = null;
    const blocks = [];
    for (let i = 0; i < days.length && remaining > 0; i++) {
      const take = Math.min(remaining, days[i].capacityMinutes - days[i].plannedMinutes);
      if (take <= 0) continue;
      const s = new Date(days[i].start.getTime() + days[i].plannedMinutes * MIN);
      const e = new Date(s.getTime() + take * MIN);
      firstStart ??= s;
      lastEnd = e;
      days[i].plannedMinutes += take;
      days[i].orders.push({ id: o.id, customerName: o.customerName, item: o.item, scheduledMinutes: take, start: s.toISOString(), end: e.toISOString() });
      blocks.push({ date: days[i].date, start: s.toISOString(), end: e.toISOString(), minutes: take });
      remaining -= take;
    }

    const unfit = remaining > 0;
    const finishAt = lastEnd ?? now;
    const bufferMinutes = unfit ? null : Math.floor((o.deadline - finishAt) / MIN);
    let risk = 'low';
    let reason = `Scheduled to finish ${fmtDur(bufferMinutes)} before the deadline.`;
    let shortfallMinutes = null;
    let suggestedDeadline = null;
    let kind = 'on_track'; // machine-readable cause: deadline_passed | unschedulable | late | tight | on_track
    if (o.deadline < now) {
      risk = 'high'; kind = 'deadline_passed'; reason = 'The deadline has already passed.';
    } else if (unfit) {
      risk = 'high'; kind = 'unschedulable'; reason = `Cannot be scheduled within the next ${HORIZON_DAYS} days of working capacity.`;
    } else if (bufferMinutes < 0) {
      risk = 'high'; kind = 'late'; shortfallMinutes = -bufferMinutes;
      reason = `Estimated to finish ${fmtDur(shortfallMinutes)} after the deadline (${formatInZone(finishAt, tz)}).`;
      suggestedDeadline = new Date(finishAt.getTime() + settings.riskBufferMinutes * MIN).toISOString();
    } else if (bufferMinutes < settings.riskBufferMinutes) {
      risk = 'medium'; kind = 'tight'; reason = `Estimated to finish only ${fmtDur(bufferMinutes)} before the deadline.`;
    }
    const entry = {
      orderId: o.id, risk, kind, reason, bufferMinutes, shortfallMinutes, suggestedDeadline,
      deadline: o.deadline.toISOString(), prepTimeMinutes: o.prepTimeMinutes,
      scheduledStart: (firstStart ?? now).toISOString(), scheduledEnd: unfit ? null : finishAt.toISOString(),
      blocks, // exact time blocks the engine placed for this order
      precededBy: queued.map((q) => ({ ...q })), // orders scheduled ahead of this one (earlier deadline), with their prep minutes
    };
    queued.push({ orderId: o.id, minutes: o.prepTimeMinutes });
    results[o.id] = entry;
    schedule.push(entry);
  }

  const shown = days.slice(0, rangeDays);
  const pendingMinutes = open.reduce((s, o) => s + (o.prepTimeMinutes ?? 0), 0);
  const availableMinutes = shown.reduce((s, d) => s + d.capacityMinutes, 0);
  const workload = {
    pendingMinutes,
    pendingHours: Math.round((pendingMinutes / 60) * 10) / 10,
    availableMinutes,
    availableHours: Math.round((availableMinutes / 60) * 10) / 10,
    utilisationPercent: availableMinutes ? Math.round((pendingMinutes / availableMinutes) * 100) : pendingMinutes ? 100 : 0,
  };
  const overloadedDays = shown.filter((d) => d.capacityMinutes > 0 && d.plannedMinutes >= d.capacityMinutes)
    .map((d) => ({ date: d.date, plannedMinutes: d.plannedMinutes, capacityMinutes: d.capacityMinutes }));

  // Uninterrupted free time: the engine packs work from the start of each day, so what is left of a day's capacity is one
  // contiguous block at its end. These are the windows where a new job could be slotted in without moving anything.
  const freeWindows = shown
    .filter((d) => d.capacityMinutes - d.plannedMinutes > 0)
    .map((d) => {
      const startMs = d.start.getTime() + d.plannedMinutes * MIN;
      const minutes = d.capacityMinutes - d.plannedMinutes;
      return { date: d.date, start: new Date(startMs).toISOString(), end: new Date(startMs + minutes * MIN).toISOString(), minutes };
    });
  const largest = (list) => list.reduce((best, w) => (!best || w.minutes > best.minutes ? w : best), null);
  const largestFreeWindow = largest(freeWindows);
  // Where a free hour matters most: the next two working days. (Later in the week there is usually plenty of room.)
  const nearDates = shown.filter((d) => d.capacityMinutes > 0).slice(0, NEAR_WORKING_DAYS).map((d) => d.date);
  const nearFreeWindow = largest(freeWindows.filter((w) => nearDates.includes(w.date)));

  const byId = Object.fromEntries(open.map((o) => [o.id, o]));
  const risks = schedule.filter((r) => r.risk !== 'low')
    .sort((a, b) => RANK[a.risk] - RANK[b.risk] || byId[a.orderId].deadline - byId[b.orderId].deadline)
    .map(({ orderId, risk, kind, reason, bufferMinutes, shortfallMinutes, suggestedDeadline }) => ({ orderId, risk, kind, reason, bufferMinutes, shortfallMinutes, suggestedDeadline }));

  return {
    range: { from: shown[0].date, days: rangeDays, timezone: tz },
    rules: { riskBufferMinutes: settings.riskBufferMinutes, horizonDays: HORIZON_DAYS },
    generatedAt: now.toISOString(),
    workload,
    days: shown.map(({ date, plannedMinutes, capacityMinutes, start, orders: dayOrders }) => ({ date, plannedMinutes, capacityMinutes, startsAt: start.toISOString(), orders: dayOrders })),
    risks,
    unscheduledOrders,
    overloadedDays,
    schedule,
    recommendations: buildRecommendations({ open: byId, risks, unscheduledOrders, overloadedDays, now, settings, rangeDays }),
    freeWindows,
    largestFreeWindow,
    nearFreeWindow,
    nextMoves: buildNextMoves({ open, schedule, unscheduledOrders, settings }),
    nextMovesRule: NEXT_MOVES_RULE,
    results,
  };
}

export const NEXT_MOVES_RULE = 'Overdue first, then orders predicted to miss their deadline, then tight buffers, then orders blocked by missing details, then on-track work. Within each group the earliest deadline comes first.';

const TIERS = {
  deadline_passed: { tier: 0, label: 'Already past due' },
  unschedulable: { tier: 1, label: 'Cannot be scheduled' },
  late: { tier: 1, label: 'Predicted to be late' },
  tight: { tier: 2, label: 'Tight buffer' },
  needs_details: { tier: 3, label: 'Needs details' },
  on_track: { tier: 4, label: 'On track' },
};

// One recommended ACTION per open order, ranked. Every number in the text comes from the schedule above; nothing is estimated here.
function buildNextMoves({ open, schedule, unscheduledOrders, settings }) {
  const tz = settings.timezone;
  const when = (iso) => formatInZone(new Date(iso), tz);
  const entry = Object.fromEntries(schedule.map((e, i) => [e.orderId, { ...e, sequence: i + 1 }]));
  const missingOf = Object.fromEntries(unscheduledOrders.map((u) => [u.id, u.reason]));
  const MISSING = { missing_prep_time: 'a preparation time', missing_deadline: 'a deadline', missing_both: 'a deadline and a preparation time' };

  const moves = open.map((o) => {
    const e = entry[o.id];
    let kind; let action; let why; let recovery = null;
    if (!e) {
      kind = 'needs_details';
      const m = MISSING[missingOf[o.id]];
      action = `Confirm details with ${o.customerName}, then add ${m}`;
      why = `It cannot be scheduled without ${m}, so it is left out of capacity planning. One message to ${o.customerName} unblocks it.`;
    } else {
      kind = e.kind;
      const queue = e.precededBy.length ? ` ${e.precededBy.length} earlier-deadline ${e.precededBy.length === 1 ? 'order is' : 'orders are'} scheduled before it.` : '';
      if (kind === 'deadline_passed') {
        action = `Contact ${o.customerName} about the missed deadline`;
        why = `The promised deadline (${when(e.deadline)}) has already passed.`;
        recovery = e.scheduledEnd ? `Agree a new date with ${o.customerName}. The earliest the scheduler can finish it is ${when(e.scheduledEnd)}.` : null;
      } else if (kind === 'unschedulable') {
        action = `Defer or decline ${o.item}`;
        why = e.reason;
      } else if (kind === 'late') {
        action = `Decide now: speed up ${o.item} or ask ${o.customerName} for more time`;
        why = `Predicted to finish ${fmtDur(e.shortfallMinutes)} after its deadline (${when(e.scheduledEnd)} vs ${when(e.deadline)}).${queue}`;
        recovery = e.suggestedDeadline ? `Offer ${o.customerName} a deadline of ${when(e.suggestedDeadline)}, or free ${fmtDur(e.shortfallMinutes)} of preparation time before ${when(e.deadline)}.` : null;
      } else if (kind === 'tight') {
        action = `Start ${o.item} on schedule (${when(e.scheduledStart)}) and protect its buffer`;
        why = `It fits, but finishes only ${fmtDur(e.bufferMinutes)} before the deadline, under your ${fmtDur(settings.riskBufferMinutes)} safety buffer.${queue}`;
        recovery = `Avoid taking new work that is due before ${when(e.deadline)}.`;
      } else {
        action = o.status === 'in_progress' ? `Keep going on ${o.item}` : `Up next: ${o.item}, starting ${when(e.scheduledStart)}`;
        why = `${fmtDur(e.bufferMinutes)} to spare before the deadline. Number ${e.sequence} in your work queue.${queue}`;
      }
    }
    return { orderId: o.id, kind, state: TIERS[kind].label, tier: TIERS[kind].tier, deadlineMs: o.deadline ? o.deadline.getTime() : Infinity, workSequence: e?.sequence ?? null, action, why, recovery };
  });

  moves.sort((a, b) => a.tier - b.tier || a.deadlineMs - b.deadlineMs || a.orderId.localeCompare(b.orderId));
  return moves.map(({ tier, deadlineMs, ...m }, i) => ({ rank: i + 1, ...m }));
}

function buildRecommendations({ open, risks, unscheduledOrders, overloadedDays, now, settings, rangeDays }) {
  const recs = [];
  const tz = settings.timezone;
  const add = (priority, action, reason, orderId = null) => recs.push({ id: `rec_${recs.length + 1}`, priority, action, reason, orderId });

  for (const r of risks.filter((x) => x.risk === 'high').slice(0, 3)) {
    const o = open[r.orderId];
    if (o.deadline < now) add('high', `Contact ${o.customerName} about the missed deadline for ${o.item}`, r.reason, o.id);
    else if (r.suggestedDeadline) add('high', `Prioritise ${o.item} for ${o.customerName}`, `${r.reason} Start immediately, free up capacity, or offer a new deadline of ${formatInZone(new Date(r.suggestedDeadline), tz)}.`, o.id);
    else add('high', `Defer or decline ${o.item} for ${o.customerName}`, r.reason, o.id);
  }
  for (const r of risks.filter((x) => x.risk === 'medium').slice(0, 2)) {
    const o = open[r.orderId];
    add('medium', `Protect the buffer on ${o.item} (${o.customerName})`, `${r.reason} Avoid taking new work before it.`, o.id);
  }
  for (const u of unscheduledOrders.slice(0, 3)) {
    const o = open[u.id];
    const what = u.reason === 'missing_deadline' ? 'a deadline' : u.reason === 'missing_prep_time' ? 'a preparation time' : 'a deadline and preparation time';
    add('medium', `Add ${what} for ${o.customerName}'s order`, 'Orders without these details are left out of deadline and capacity planning.', o.id);
  }
  const soon = now.getTime() + 72 * 3600000;
  for (const o of Object.values(open).filter((x) => x.deadline && x.deadline.getTime() < soon && ['unverified', 'pending', 'partial'].includes(x.paymentStatus)).slice(0, 2)) {
    add('medium', `Confirm payment for ${o.customerName}`, 'Payment is not verified and the deadline is within 3 days.', o.id);
  }
  if (overloadedDays.length && recs.length === 0) {
    add('low', `Limit new orders on ${overloadedDays[0].date}`, `${overloadedDays.length} of the next ${rangeDays} days are fully booked.`);
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return recs.map((r, i) => ({ ...r, i })).sort((a, b) => rank[a.priority] - rank[b.priority] || a.i - b.i).map(({ i, ...r }, n) => ({ ...r, id: `rec_${n + 1}` }));
}

export const publicPlan = ({ results, schedule, ...rest }) => ({ ...rest, schedule });

const riskCounts = (plan) => ({
  high: plan.schedule.filter((e) => e.risk === 'high').length,
  medium: plan.schedule.filter((e) => e.risk === 'medium').length,
  low: plan.schedule.filter((e) => e.risk === 'low').length,
  details: plan.unscheduledOrders.length,
});

// Would one more job of `minutes` fit? Asked of the engine itself: add a probe order due when the largest free window ends and
// see whether it (and everything else) stays safe. No new scheduling logic.
function probeFit({ hypo, after, settings, now, rangeDays, minutes }) {
  const near = after.nearFreeWindow && after.nearFreeWindow.minutes >= minutes ? after.nearFreeWindow : null;
  const window = near ?? after.largestFreeWindow;
  if (!window || window.minutes < minutes) {
    return { minutes, fits: false, window: null, scope: null, reason: `There is no uninterrupted ${fmtDur(minutes)} window in the next ${rangeDays} days.` };
  }
  const scope = near ? 'next_working_days' : 'later';
  const probe = { id: 'probe', customerName: 'New order', item: 'New order', quantity: 1, status: 'pending', paymentStatus: 'unverified', prepTimeMinutes: minutes, deadline: new Date(window.end) };
  const withProbe = computePlan({ orders: [...hypo, probe], settings, now, rangeDays });
  const mine = withProbe.schedule.find((e) => e.orderId === 'probe');
  const rank = { low: 0, medium: 1, high: 2 };
  const baseRisk = Object.fromEntries(after.schedule.map((e) => [e.orderId, e.risk]));
  const worsened = withProbe.schedule.filter((e) => e.orderId !== 'probe' && rank[e.risk] > rank[baseRisk[e.orderId]]).map((e) => e.orderId);
  const fits = Boolean(mine) && mine.risk !== 'high' && worsened.length === 0;
  return { minutes, fits, window, scope, startsAt: mine?.scheduledStart ?? null, finishesAt: mine?.scheduledEnd ?? null, risk: mine?.risk ?? null, worsenedOrderIds: worsened,
    reason: fits ? null : worsened.length ? 'Fitting it in would push an existing order closer to (or past) its deadline.' : 'It would not finish in time even in the free window.' };
}

// ---- What-if simulation -------------------------------------------------------------------------------------------
export function simulate({ orders, changes, settings, now = new Date(), rangeDays = 7, probeMinutes = 60 }) {
  const invalid = (details) => new ApiError(422, 'VALIDATION_ERROR', 'Request validation failed.', details);
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 20) throw invalid([{ field: 'changes', message: 'Provide between 1 and 20 changes.' }]);

  const hypo = orders.map((o) => ({ ...normalizeOrder(o) }));
  const knownIds = new Set(hypo.map((o) => o.id));
  changes.forEach((c, i) => {
    const at = `changes[${i}]`;
    if (!c || typeof c !== 'object') throw invalid([{ field: at, message: 'Must be an object.' }]);
    if (c.type === 'add_order') {
      const { value, details } = validateOrderInput(c.order);
      if (details.length) throw invalid(details.map((d) => ({ ...d, field: `${at}.order.${d.field}` })));
      hypo.push({ id: `change_${i}`, status: 'pending', paymentStatus: 'unverified', prepTimeMinutes: null, deadline: null, ...value });
    } else if (c.type === 'update_order' || c.type === 'cancel_order') {
      if (typeof c.orderId !== 'string' || !knownIds.has(c.orderId)) throw new ApiError(404, 'NOT_FOUND', `Order '${c.orderId}' not found.`);
      const idx = hypo.findIndex((o) => o.id === c.orderId);
      if (c.type === 'cancel_order') hypo[idx] = { ...hypo[idx], status: 'cancelled' };
      else {
        const { value, details } = validateOrderInput(c.order, { partial: true });
        if (details.length) throw invalid(details.map((d) => ({ ...d, field: `${at}.order.${d.field}` })));
        hypo[idx] = { ...hypo[idx], ...value };
      }
    } else throw invalid([{ field: `${at}.type`, message: 'Must be add_order, update_order or cancel_order.' }]);
  });

  const before = computePlan({ orders, settings, now, rangeDays });
  const after = computePlan({ orders: hypo, settings, now, rangeDays });
  const beforeRisk = Object.fromEntries(before.risks.map((r) => [r.orderId, r]));
  const afterRisk = Object.fromEntries(after.risks.map((r) => [r.orderId, r]));

  const newRisks = after.risks
    .filter((r) => !beforeRisk[r.orderId] || (beforeRisk[r.orderId].risk === 'medium' && r.risk === 'high'))
    .map((r) => ({ ...r, previousRisk: beforeRisk[r.orderId]?.risk ?? null }));
  const resolvedRisks = before.risks.filter((r) => !afterRisk[r.orderId]).map((r) => ({ orderId: r.orderId }));

  const suggestedAdjustments = [];
  for (const r of newRisks.filter((x) => x.risk === 'high')) {
    if (r.suggestedDeadline) {
      suggestedAdjustments.push({
        orderId: r.orderId, type: 'extend_deadline', suggestedDeadline: r.suggestedDeadline,
        explanation: `With this change the order would finish ${fmtDur(r.shortfallMinutes)} late. Moving its deadline to ${formatInZone(new Date(r.suggestedDeadline), settings.timezone)} restores a safe buffer.`,
      });
    } else {
      suggestedAdjustments.push({ orderId: r.orderId, type: 'reduce_workload', explanation: `${r.reason} Remove or defer other work, or decline this change.` });
    }
  }

  const fit = probeFit({ hypo, after, settings, now, rangeDays, minutes: probeMinutes });

  return {
    simulated: true,
    // The "before" plan from the SAME moment as the simulated one, so differences are caused only by the change, never by the clock.
    baseline: { generatedAt: before.generatedAt, schedule: before.schedule, unscheduledOrders: before.unscheduledOrders },
    planner: publicPlan(after),
    comparison: {
      currentCounts: riskCounts(before),
      simulatedCounts: riskCounts(after),
      currentNearFreeWindow: before.nearFreeWindow,
      simulatedNearFreeWindow: after.nearFreeWindow,
      currentLargestFreeWindow: before.largestFreeWindow,
      simulatedLargestFreeWindow: after.largestFreeWindow,
      fit,
      pendingMinutesDelta: after.workload.pendingMinutes - before.workload.pendingMinutes,
      currentWorkload: before.workload,
      simulatedWorkload: after.workload,
      newRisks,
      resolvedRisks,
      conflicts: after.risks.filter((r) => r.risk === 'high').map(({ orderId, shortfallMinutes, reason }) => ({ orderId, shortfallMinutes, reason })),
      overloadedDays: after.overloadedDays,
      suggestedAdjustments,
    },
  };
}

// ---- Suggested experiment --------------------------------------------------------------------------------------------
// Tries a handful of concrete changes through simulate() and keeps the best one that creates no new risk. Goal: an
// uninterrupted free hour in the next two working days, and fewer deadline risks.
//  * "give one order a day more": reorders work, so it can resolve risks. It can NOT free time (the scheduler works ASAP).
//  * "prepare one order faster": an ASSUMPTION (batching, pre-making). It is the only kind of change that frees time, so it
//    is labelled as an assumption and the engine reports what it really does.
// Falls back to a capacity check. Deterministic, and nothing is saved.
export function suggestScenario({ orders, settings, now = new Date(), rangeDays = 7, goalMinutes = 60 }) {
  const tz = settings.timezone;
  const base = computePlan({ orders, settings, now, rangeDays });
  const baseNear = base.nearFreeWindow?.minutes ?? 0;
  const norm = Object.fromEntries(orders.map(normalizeOrder).map((o) => [o.id, o]));
  const nameOf = (id) => norm[id]?.customerName ?? id;

  const evaluate = (change) => {
    const c = simulate({ orders, changes: [change], settings, now, rangeDays, probeMinutes: goalMinutes }).comparison;
    const afterNear = c.simulatedNearFreeWindow?.minutes ?? 0;
    return { change, resolved: c.resolvedRisks.map((r) => r.orderId), newRisks: c.newRisks.length, afterNear,
      opensHour: baseNear < goalMinutes && afterNear >= goalMinutes, gain: afterNear - baseNear };
  };

  const scored = [];
  for (const e of base.schedule) {
    const o = norm[e.orderId];
    const to = new Date(o.deadline.getTime() + 24 * 3600000);
    scored.push({ kind: 'move_deadline', o, to, ...evaluate({ type: 'update_order', orderId: o.id, order: { deadline: to.toISOString() } }) });
    if (baseNear < goalMinutes && o.prepTimeMinutes > 30) {
      const cut = Math.min(o.prepTimeMinutes - 15, Math.ceil(Math.max(goalMinutes - baseNear, 30) / 15) * 15);
      scored.push({ kind: 'reduce_prep', o, cut, ...evaluate({ type: 'update_order', orderId: o.id, order: { prepTimeMinutes: o.prepTimeMinutes - cut } }) });
    }
  }
  const useful = scored.filter((c) => c.newRisks === 0 && (c.opensHour || c.resolved.length > 0 || c.gain > 0));
  useful.sort((a, b) => Number(b.opensHour) - Number(a.opensHour) || b.resolved.length - a.resolved.length || b.gain - a.gain || (a.kind === 'move_deadline' ? -1 : 1));

  if (useful.length) {
    const t = useful[0];
    const outcome = [t.opensHour ? `opens an uninterrupted free hour in your next two working days` : null, t.resolved.length ? `resolves the deadline risk on ${t.resolved.map(nameOf).join(' and ')}'s order` : null].filter(Boolean).join(' and ');
    if (t.kind === 'reduce_prep') {
      return {
        kind: 'reduce_prep',
        title: `What if ${t.o.customerName}'s ${t.o.item} took ${fmtDur(t.cut)} less?`,
        summary: `Assume you can prepare it in ${fmtDur(t.o.prepTimeMinutes - t.cut)} instead of ${fmtDur(t.o.prepTimeMinutes)}, for example by batching similar items or pre-making components.`,
        why: `This is an assumption, not a fact: change the minutes to what is realistic. In the scheduler's pre-check, this ${outcome || 'frees time'} without making any other order worse.`,
        goalMinutes,
        changes: [{ type: 'update_order', orderId: t.o.id, order: { prepTimeMinutes: t.o.prepTimeMinutes - t.cut } }],
      };
    }
    return {
      kind: 'move_deadline',
      title: `Ask ${t.o.customerName} for one more day`,
      summary: `Move ${t.o.customerName}'s promised deadline for ${t.o.item} from ${formatInZone(t.o.deadline, tz)} to ${formatInZone(t.to, tz)}.`,
      why: `This reorders your work. In the scheduler's pre-check it ${outcome || 'improves the schedule'} without making any other order worse. It cannot free extra time on its own.`,
      goalMinutes,
      changes: [{ type: 'update_order', orderId: t.o.id, order: { deadline: t.to.toISOString() } }],
    };
  }

  const w = base.nearFreeWindow ?? base.largestFreeWindow;
  if (w && w.minutes >= goalMinutes) {
    return {
      kind: 'capacity_check',
      title: `Could you take a ${fmtDur(goalMinutes)} rush order?`,
      summary: `Add a ${fmtDur(goalMinutes)} order due when your free window ends (${formatInZone(new Date(w.end), tz)}).`,
      why: `Nothing needs rescuing, and you already have an uninterrupted free window of ${fmtDur(w.minutes)}. This checks that a new order fits without hurting the others.`,
      goalMinutes,
      changes: [{ type: 'add_order', order: { customerName: 'New customer', item: 'Rush order', quantity: 1, prepTimeMinutes: goalMinutes, deadline: w.end, source: 'manual' } }],
    };
  }
  return null;
}
