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
  for (const o of plannable) {
    let remaining = o.prepTimeMinutes;
    let firstStart = null;
    let lastEnd = null;
    for (let i = 0; i < days.length && remaining > 0; i++) {
      const take = Math.min(remaining, days[i].capacityMinutes - days[i].plannedMinutes);
      if (take <= 0) continue;
      const s = new Date(days[i].start.getTime() + days[i].plannedMinutes * MIN);
      const e = new Date(s.getTime() + take * MIN);
      firstStart ??= s;
      lastEnd = e;
      days[i].plannedMinutes += take;
      days[i].orders.push({ id: o.id, customerName: o.customerName, item: o.item, scheduledMinutes: take });
      remaining -= take;
    }

    const unfit = remaining > 0;
    const finishAt = lastEnd ?? now;
    const bufferMinutes = unfit ? null : Math.floor((o.deadline - finishAt) / MIN);
    let risk = 'low';
    let reason = `Scheduled to finish ${fmtDur(bufferMinutes)} before the deadline.`;
    let shortfallMinutes = null;
    let suggestedDeadline = null;
    if (o.deadline < now) {
      risk = 'high'; reason = 'The deadline has already passed.';
    } else if (unfit) {
      risk = 'high'; reason = `Cannot be scheduled within the next ${HORIZON_DAYS} days of working capacity.`;
    } else if (bufferMinutes < 0) {
      risk = 'high'; shortfallMinutes = -bufferMinutes;
      reason = `Estimated to finish ${fmtDur(shortfallMinutes)} after the deadline (${formatInZone(finishAt, tz)}).`;
      suggestedDeadline = new Date(finishAt.getTime() + settings.riskBufferMinutes * MIN).toISOString();
    } else if (bufferMinutes < settings.riskBufferMinutes) {
      risk = 'medium'; reason = `Estimated to finish only ${fmtDur(bufferMinutes)} before the deadline.`;
    }
    const entry = {
      orderId: o.id, risk, reason, bufferMinutes, shortfallMinutes, suggestedDeadline,
      scheduledStart: (firstStart ?? now).toISOString(), scheduledEnd: unfit ? null : finishAt.toISOString(),
    };
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

  const byId = Object.fromEntries(open.map((o) => [o.id, o]));
  const risks = schedule.filter((r) => r.risk !== 'low')
    .sort((a, b) => RANK[a.risk] - RANK[b.risk] || byId[a.orderId].deadline - byId[b.orderId].deadline)
    .map(({ orderId, risk, reason, bufferMinutes, shortfallMinutes, suggestedDeadline }) => ({ orderId, risk, reason, bufferMinutes, shortfallMinutes, suggestedDeadline }));

  return {
    range: { from: shown[0].date, days: rangeDays, timezone: tz },
    workload,
    days: shown.map(({ date, plannedMinutes, capacityMinutes, orders: dayOrders }) => ({ date, plannedMinutes, capacityMinutes, orders: dayOrders })),
    risks,
    unscheduledOrders,
    overloadedDays,
    schedule,
    recommendations: buildRecommendations({ open: byId, risks, unscheduledOrders, overloadedDays, now, settings, rangeDays }),
    results,
  };
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
  for (const o of Object.values(open).filter((x) => x.deadline && x.deadline.getTime() < soon && ['unverified', 'pending'].includes(x.paymentStatus)).slice(0, 2)) {
    add('medium', `Confirm payment for ${o.customerName}`, 'Payment is not verified and the deadline is within 3 days.', o.id);
  }
  if (overloadedDays.length && recs.length === 0) {
    add('low', `Limit new orders on ${overloadedDays[0].date}`, `${overloadedDays.length} of the next ${rangeDays} days are fully booked.`);
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return recs.map((r, i) => ({ ...r, i })).sort((a, b) => rank[a.priority] - rank[b.priority] || a.i - b.i).map(({ i, ...r }, n) => ({ ...r, id: `rec_${n + 1}` }));
}

export const publicPlan = ({ results, schedule, ...rest }) => ({ ...rest, schedule });

// ---- What-if simulation -------------------------------------------------------------------------------------------
export function simulate({ orders, changes, settings, now = new Date(), rangeDays = 7 }) {
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

  return {
    simulated: true,
    planner: publicPlan(after),
    comparison: {
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
