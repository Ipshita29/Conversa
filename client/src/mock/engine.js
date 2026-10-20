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
    range: { from: shown[0].date, days: rangeDays },
    workload: { pendingMinutes, availableMinutes, utilisationPercent: availableMinutes ? Math.round((pendingMinutes / availableMinutes) * 100) : 0 },
    days: shown, risks, unscheduledOrders: unscheduled, recommendations,
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
