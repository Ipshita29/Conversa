// Rule-based workload engine for the DEMO backend. Mirrors the shared logic in docs/api-contract.md §2:
// only open orders with a known prep time count; completed/cancelled are always excluded.
// Dashboard and planner both call buildPlanner so their numbers always agree.
export const OPEN_STATUSES = ['pending', 'confirmed', 'in_progress'];
const DAY = 86400000;
const BUFFER_HOURS = 4; // below this much slack an order is 'medium' risk
const CAPACITY_BY_WEEKDAY = [0, 360, 360, 360, 360, 360, 240]; // Sun..Sat, minutes (demo working hours)

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const isoDate = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const isOpen = (o) => OPEN_STATUSES.includes(o.status);

function schedule(orders, from, horizon = 30) {
  const start = startOfDay(from);
  const days = Array.from({ length: horizon }, (_, i) => {
    const d = new Date(start.getTime() + i * DAY);
    return { date: isoDate(d), plannedMinutes: 0, capacityMinutes: CAPACITY_BY_WEEKDAY[d.getDay()], orders: [] };
  });

  const results = {};
  const unscheduled = [];
  const plannable = [];
  for (const o of orders.filter(isOpen)) {
    const noPrep = o.prepTimeMinutes == null;
    const noDeadline = !o.deadline;
    if (noPrep || noDeadline) {
      unscheduled.push({ id: o.id, reason: noPrep && noDeadline ? 'missing_both' : noPrep ? 'missing_prep_time' : 'missing_deadline' });
    } else plannable.push(o);
  }

  // Earliest-deadline-first; fill the earliest days that still have capacity.
  plannable.sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
  for (const o of plannable) {
    let remaining = o.prepTimeMinutes;
    let last = -1;
    for (let i = 0; i < horizon && remaining > 0; i++) {
      const take = Math.min(remaining, days[i].capacityMinutes - days[i].plannedMinutes);
      if (take > 0) {
        days[i].plannedMinutes += take;
        days[i].orders.push({ id: o.id, customerName: o.customerName, item: o.item, scheduledMinutes: take });
        remaining -= take;
        last = i;
      }
    }
    // Estimated finish = 09:00 on the last working day + minutes already booked that day.
    const finishAt = last >= 0 ? new Date(new Date(`${days[last].date}T09:00:00`).getTime() + days[last].plannedMinutes * 60000) : null;
    const bufferH = finishAt ? (new Date(o.deadline) - finishAt) / 36e5 : -1;
    let risk = 'low';
    let reason = `Fits within capacity with about ${Math.floor(bufferH)}h to spare.`;
    if (new Date(o.deadline) < Date.now()) { risk = 'high'; reason = 'The deadline has already passed.'; }
    else if (remaining > 0 || bufferH < 0) { risk = 'high'; reason = 'Not enough working hours to finish before the deadline.'; }
    else if (bufferH < BUFFER_HOURS) { risk = 'medium'; reason = `Estimated to finish only ${Math.max(0, Math.round(bufferH))}h before the deadline.`; }
    results[o.id] = { risk, reason };
  }
  return { days, results, unscheduled };
}

export function annotateRisk(orders, from = new Date()) {
  const { results } = schedule(orders, from);
  return orders.map((o) => ({ ...o, risk: isOpen(o) ? results[o.id]?.risk ?? null : null }));
}

export function buildPlanner(orders, from = new Date(), rangeDays = 7) {
  const { days, results, unscheduled } = schedule(orders, from);
  const shown = days.slice(0, rangeDays);
  const open = orders.filter(isOpen);
  const pendingMinutes = open.reduce((s, o) => s + (o.prepTimeMinutes ?? 0), 0);
  const availableMinutes = shown.reduce((s, d) => s + d.capacityMinutes, 0);
  const byId = Object.fromEntries(orders.map((o) => [o.id, o]));

  const risks = Object.entries(results)
    .filter(([, r]) => r.risk !== 'low')
    .map(([orderId, r]) => ({ orderId, risk: r.risk, reason: r.reason }))
    .sort((a, b) => (a.risk === b.risk ? 0 : a.risk === 'high' ? -1 : 1));

  const recommendations = [];
  const rec = (priority, action, reason, orderId = null) => recommendations.push({ id: `rec_${recommendations.length + 1}`, priority, action, reason, orderId });
  for (const r of risks.filter((x) => x.risk === 'high').slice(0, 3)) {
    const o = byId[r.orderId];
    rec('high', `Prioritise ${o.item} for ${o.customerName}`, `${r.reason} Consider renegotiating the deadline or starting today.`, o.id);
  }
  for (const r of risks.filter((x) => x.risk === 'medium').slice(0, 2)) {
    const o = byId[r.orderId];
    rec('medium', `Protect the buffer on ${o.item} (${o.customerName})`, r.reason, o.id);
  }
  for (const u of unscheduled.slice(0, 2)) {
    const o = byId[u.id];
    rec('medium', `Complete details for ${o.customerName}'s order`, u.reason === 'missing_deadline' ? 'No deadline is set, so it is excluded from capacity planning.' : u.reason === 'missing_prep_time' ? 'No preparation time is set, so it is excluded from capacity planning.' : 'Deadline and prep time are both missing.', o.id);
  }
  const soon = Date.now() + 72 * 36e5;
  for (const o of open.filter((x) => x.deadline && new Date(x.deadline) < soon && ['unverified', 'pending'].includes(x.paymentStatus)).slice(0, 2)) {
    rec('medium', `Confirm payment for ${o.customerName}`, 'Payment is not verified and the deadline is within 3 days.', o.id);
  }
  const rank = { high: 0, medium: 1, low: 2 };
  recommendations.sort((a, b) => rank[a.priority] - rank[b.priority]);

  return {
    range: { from: shown[0].date, days: rangeDays, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    workload: { pendingMinutes, availableMinutes, utilisationPercent: availableMinutes ? Math.round((pendingMinutes / availableMinutes) * 100) : 0 },
    days: shown, risks, unscheduledOrders: unscheduled, recommendations,
    // Demo mock has no clock-level schedule: finish times are unknown (null), risks come from the day-based rule above.
    // Demo mock only: a basic ranking from the mock's day-based risks (the real scheduler gives much richer reasons).
    nextMoves: [...open.map((o) => ({ o, r: results[o.id] }))].map(({ o, r }) => {
      const kind = !r ? 'needs_details' : r.risk === 'high' ? 'late' : r.risk === 'medium' ? 'tight' : 'on_track';
      const tier = { late: 1, tight: 2, needs_details: 3, on_track: 4 }[kind];
      const state = { late: 'Predicted to be late', tight: 'Tight buffer', needs_details: 'Needs details', on_track: 'On track' }[kind];
      return { tier, d: o.deadline ? new Date(o.deadline).getTime() : Infinity, m: { orderId: o.id, kind, state, workSequence: r ? Object.keys(results).indexOf(o.id) + 1 : null, action: kind === 'needs_details' ? `Confirm details with ${o.customerName}` : `Work on ${o.item} for ${o.customerName}`, why: r?.reason ?? 'Missing a preparation time or deadline, so it cannot be scheduled.', recovery: null } };
    }).sort((a, b) => a.tier - b.tier || a.d - b.d).map((x, i) => ({ rank: i + 1, ...x.m })),
    nextMovesRule: 'Predicted late first, then tight buffers, then missing details, then on-track work. Earliest deadline first within each group.',
    schedule: Object.entries(results).map(([orderId, r]) => ({ orderId, risk: r.risk, kind: r.risk === 'high' ? 'late' : r.risk === 'medium' ? 'tight' : 'on_track', reason: r.reason, deadline: byId[orderId]?.deadline ?? null, bufferMinutes: null, shortfallMinutes: null, suggestedDeadline: null, scheduledStart: null, scheduledEnd: null })),
  };
}

export function buildDashboard(orders) {
  const withRisk = annotateRisk(orders);
  const planner = buildPlanner(orders, new Date(), 7);
  const open = withRisk.filter(isOpen);
  const byDeadline = [...open].filter((o) => o.deadline).sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
  return {
    stats: {
      total: orders.length,
      pending: orders.filter((o) => ['pending', 'confirmed'].includes(o.status)).length,
      inProgress: orders.filter((o) => o.status === 'in_progress').length,
      completed: orders.filter((o) => o.status === 'completed').length,
      atRisk: open.filter((o) => o.risk === 'medium' || o.risk === 'high').length,
    },
    workload: {
      pendingMinutes: planner.workload.pendingMinutes,
      availableMinutes: planner.workload.availableMinutes,
      daily: planner.days.map(({ date, plannedMinutes, capacityMinutes }) => ({ date, plannedMinutes, capacityMinutes })),
    },
    urgentOrders: byDeadline
      .filter((o) => o.risk === 'high' || o.risk === 'medium' || new Date(o.deadline) - Date.now() < 48 * 36e5)
      .slice(0, 5)
      .map(({ id, customerName, item, deadline, prepTimeMinutes, status, risk }) => ({ id, customerName, item, deadline, prepTimeMinutes, status, risk })),
    upcomingDeadlines: byDeadline.slice(0, 5).map(({ id, customerName, deadline }) => ({ id, customerName, deadline })),
    recommendations: planner.recommendations,
  };
}
