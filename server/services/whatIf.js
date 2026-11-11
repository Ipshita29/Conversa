// Smart Commitment Management: help the owner make delivery promises they can keep. Every answer here comes from the SAME workload engine the Plan
// and the Dashboard use (computePlan / simulate), run on copies of the real orders. Nothing is scheduled here and nothing is written; changing a
// real deadline is a separate, explicit step (PATCH /orders/:id) that the owner confirms.
//   overview   which orders can keep their deadline, which cannot, and for each the EARLIEST realistic deadline the schedule can support.
//   runMove    the schedule with ONE order's deadline changed: before/after conflicts, at-risk orders, feasibility, and who else is affected.
// An order whose deadline has ALREADY passed is overdue: it is a conflict, but "can the schedule keep it" is the wrong question, so it is counted
// separately and the earliest realistic deadline is what helps.
import { computePlan, simulate } from './workloadEngine.js';
import { OPEN_STATUSES } from '../utils/validation.js';
import { DEMO_MARK, DEMO_START, SCENARIO_DUE } from '../scripts/demo-data.js';
import { zonedParts, zonedTimeToUtc, addDays, weekdayOf, parseHm } from '../utils/timezone.js';

// 'demo' = the five seeded demo orders, planned from the real clock; anything else = every order loaded for the business.
export const scopeOrders = (orders, scope) => (scope === 'demo' || scope === 'commitment' ? orders.filter((o) => typeof o.notes === 'string' && o.notes.startsWith(DEMO_MARK)) : orders);
export const scopeNow = (scope, settings, now) => now;

// 'commitment' = the What-if scenario: the same five demo orders (same customers, products and preparation times) with their requested delivery times
// placed on ONE production day, the next working morning (today when it is still before production starts). Aanya and Kartik both ask for 10:30,
// Rohan and the rush order for noon, Meera for 14:00. These are COPIES with moved deadlines: no order is changed, and the schedule is still worked out
// by the engine, from 9:00 that day. The day moves with the calendar, so the scenario never goes stale.
export function scopeInputs(orders, scope, settings, now) {
  const picked = scopeOrders(orders, scope);
  if (scope !== 'commitment') return { orders: picked, now: scopeNow(scope, settings, now) };
  const tz = settings.timezone; const t = zonedParts(now, tz);
  let day = { year: t.year, month: t.month, day: t.day };
  const at = (d, hm) => zonedTimeToUtc({ ...d, ...parseHm(hm) }, tz);
  while (!settings.workingDays.includes(weekdayOf(day)) || at(day, DEMO_START) < now) day = addDays(day, 1);
  return {
    orders: picked.map((o) => (SCENARIO_DUE[o.customerName] ? { ...o, deadline: at(day, SCENARIO_DUE[o.customerName]) } : o)),
    now: at(day, DEMO_START),
  };
}

// ---- Apply to Plan ------------------------------------------------------------------------------------------------------------------------
// The schedule itself is never stored (the engine works it out from the orders, so it cannot go stale). What an approved scenario persists is the
// COMMITMENT behind it: the delivery deadlines it asked for, and the moment production starts. These two helpers are shared by the server and the demo.
const time = (d) => new Date(d).getTime();
const idOf = (o) => String(o.id ?? o._id);
// The open orders whose stored deadline differs from the scenario's: the only thing applying changes (never status, payment, pictures or messages).
export function commitmentChanges(orders, scenarioOrders) {
  const stored = Object.fromEntries(orders.map((o) => [idOf(o), o]));
  return scenarioOrders.filter((s) => isOpen(s) && stored[idOf(s)] && time(stored[idOf(s)].deadline) !== time(s.deadline)).map((s) => ({ id: idOf(s), customerName: s.customerName, from: stored[idOf(s)].deadline ?? null, to: iso(s.deadline) }));
}
// Is this scenario already the plan? The stored production start is the scenario's, and every deadline already matches.
export const commitmentApplied = ({ orders, scenario, storedStart }) => Boolean(storedStart) && time(storedStart) === scenario.now.getTime() && commitmentChanges(orders, scenario.orders).length === 0;
// The moment the Plan is worked out from: now, or the applied commitment's production start while that is still ahead.
export const planNow = (now, storedStart) => (storedStart && time(storedStart) > now.getTime() ? new Date(storedStart) : now);

const MIN = 60000;
const STEP = 15 * MIN; // suggested deadlines are rounded UP to a quarter of an hour: a promise a person can say out loud
const iso = (d) => (d instanceof Date ? d : new Date(d)).toISOString();
const isOpen = (o) => OPEN_STATUSES.includes(o.status);
const attributable = (e) => e.risk === 'high' && e.kind !== 'deadline_passed'; // late because of the SCHEDULE (not because the calendar already moved on)
const byStart = (x, y) => Date.parse(x.start) - Date.parse(y.start);
const byIdOf = (orders) => Object.fromEntries(orders.map((o) => [String(o.id ?? o._id), { ...o, id: String(o.id ?? o._id) }]));

const card = (e, byId) => ({
  id: e.orderId, customerName: byId[e.orderId].customerName, item: byId[e.orderId].item, status: byId[e.orderId].status, ordered: byId[e.orderId].createdAt ? iso(byId[e.orderId].createdAt) : null,
  deadline: e.deadline, prepTimeMinutes: e.prepTimeMinutes, start: e.scheduledStart, end: e.scheduledEnd,
  risk: e.risk, kind: e.kind, shortfallMinutes: e.shortfallMinutes ?? null, bufferMinutes: e.bufferMinutes ?? null,
});

// The numbers the page compares before and after.
const verdict = (schedule, unscheduled = []) => {
  const late = schedule.filter(attributable);
  const overdue = schedule.filter((e) => e.kind === 'deadline_passed');
  return {
    feasible: late.length === 0 && overdue.length === 0,
    late: late.map((e) => ({ orderId: e.orderId, shortfallMinutes: e.shortfallMinutes ?? null, kind: e.kind })), overdue: overdue.map((e) => e.orderId),
    conflicts: late.length + overdue.length, // orders that miss (or have missed) their deadline
    atRisk: schedule.filter((e) => e.risk !== 'low').length, // missed or too close to call (inside the safe buffer)
    unscheduled: unscheduled.length,
  };
};

// ---- The earliest realistic deadline ----------------------------------------------------------------------------------------------------
// The smallest deadline (to the quarter hour) the owner can PROMISE: the order is not late AND no other order that was fine becomes late. Found by asking the engine, not by arithmetic here: put the order first in the queue to see the soonest it could
// possibly finish, then keep nudging the deadline to where the scheduler really places it until the answer is stable. null = it cannot be scheduled.
export function earliestDeadline({ orders, settings, now, orderId }) {
  const input = orders.map((o) => ({ ...o, id: String(o.id ?? o._id) }));
  const target = input.find((o) => o.id === String(orderId));
  if (!target || !isOpen(target) || target.prepTimeMinutes === null || target.prepTimeMinutes === undefined) return null;
  const plan = (deadline) => computePlan({ orders: input.map((o) => (o.id === target.id ? { ...o, deadline } : o)), settings, now, rangeDays: 1 });
  const alreadyLate = new Set(plan(target.deadline ?? new Date(now.getTime() + 365 * 86400000)).schedule.filter(attributable).map((e) => e.orderId));
  const soonest = plan(new Date(now.getTime() + MIN)).results[target.id]; // a deadline of "right now" puts the order at the front of the queue
  if (!soonest?.scheduledEnd) return null;
  let candidate = Math.ceil(Date.parse(soonest.scheduledEnd) / STEP) * STEP;
  for (let i = 0; i < 400; i += 1) {
    const p = plan(new Date(candidate));
    const mine = p.results[target.id];
    if (!mine?.scheduledEnd) return null;
    const end = Date.parse(mine.scheduledEnd);
    const harmed = p.schedule.filter((e) => e.orderId !== target.id && attributable(e) && !alreadyLate.has(e.orderId));
    if (mine.risk !== 'high' && harmed.length === 0) return { deadline: new Date(candidate).toISOString(), finish: mine.scheduledEnd, bufferMinutes: Math.round((candidate - end) / MIN) };
    candidate = Math.ceil(Math.max(end, candidate + STEP) / STEP) * STEP;
  }
  return null;
}

// ---- The page's data ---------------------------------------------------------------------------------------------------------------------
// Every open order with where the schedule puts it today, whether it can keep its deadline, and the earliest realistic deadline for it.
export function overview({ orders, settings, now }) {
  const input = orders.map((o) => ({ ...o }));
  const byId = byIdOf(input);
  const plan = computePlan({ orders: input, settings, now, rangeDays: 1 });
  const cards = plan.schedule.map((e) => ({ ...card(e, byId), earliest: earliestDeadline({ orders: input, settings, now, orderId: e.orderId }) })).sort(byStart);
  return {
    timezone: settings.timezone, now: now.toISOString(), cards, ...verdict(plan.schedule, plan.unscheduledOrders),
    needsDetails: plan.unscheduledOrders.map((u) => ({ id: u.id, customerName: byId[u.id]?.customerName ?? u.id, reason: u.reason })),
  };
}

// ---- Move a deadline ------------------------------------------------------------------------------------------------------------------
// ONE open order gets a proposed deadline; the engine re-plans every order on a copy. The proposal is unapplied: it is not agreed with the customer,
// and nothing is saved until the owner confirms and the order's deadline is updated.
export function runMove({ orders, settings, now, orderId, deadline }) {
  const input = orders.map((o) => ({ ...o }));
  const failure = (error, message) => ({ ok: false, error, message });
  const byId = byIdOf(input);
  const o = byId[String(orderId)];
  if (!o || !isOpen(o)) return failure('unknown_order', 'Choose one of the open orders.');
  if (o.prepTimeMinutes === null || o.prepTimeMinutes === undefined || !o.deadline) return failure('needs_details', 'This order needs a deadline and a preparation time before it can be planned.');
  const when = new Date(deadline);
  if (typeof deadline !== 'string' || Number.isNaN(when.getTime())) return failure('bad_deadline', 'Enter the proposed deadline as a date and time.');
  if (when <= now) return failure('past', 'The proposed deadline has already passed.');
  let sim;
  try { sim = simulate({ orders: input, changes: [{ type: 'update_order', orderId: String(orderId), order: { deadline: when.toISOString() } }], settings, now, rangeDays: 1 }); }
  catch (e) { return failure('bad_deadline', e.details?.[0]?.message ?? e.message); }

  const before = sim.baseline.schedule; const after = sim.planner.schedule;
  const of = (list, id) => list.find((e) => e.orderId === id);
  const affected = after.filter((e) => e.orderId !== String(orderId)).map((e) => ({ now: card(e, byId), was: card(of(before, e.orderId), byId) }))
    .filter(({ now: n, was: w }) => n.end !== w.end || n.risk !== w.risk).map(({ now: n, was: w }) => ({ ...n, wasEnd: w.end, wasRisk: w.risk }));
  const b = verdict(before); const a = verdict(after);
  return {
    ok: true, timezone: settings.timezone,
    proposal: { orderId: String(orderId), customerName: o.customerName, item: o.item, from: iso(o.deadline), to: when.toISOString(), status: 'unapplied' },
    moved: { before: card(of(before, String(orderId)), byId), after: card(of(after, String(orderId)), byId) },
    before: { ...b, cards: before.map((e) => card(e, byId)).sort(byStart) }, after: { ...a, cards: after.map((e) => card(e, byId)).sort(byStart) }, affected,
    newRisks: a.late.map((l) => l.orderId).filter((id) => !b.late.some((x) => x.orderId === id)), // late after, not late before
    resolved: [...b.late.map((l) => l.orderId), ...b.overdue].filter((id) => !a.late.some((x) => x.orderId === id) && !a.overdue.includes(id)),
  };
}
