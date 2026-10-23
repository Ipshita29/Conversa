import { dateKey, OPEN } from './format.js';

const KIND_RANK = { deadline_passed: 0, late: 1, unschedulable: 1, needs_details: 2, tight: 3 };

// Everything the Home page says about "today", derived once from the planner and orders the API already returns (no new calculations):
//  - open: pending, confirmed or in progress (cancelled and completed excluded)
//  - today: open orders due today OR with preparation starting today (each counted once)
//  - attention: open orders that are overdue, predicted late or tight (the scheduler's risk) plus those missing details (each counted once)
export function summarise({ planner, orders }) {
  const tz = planner.range.timezone;
  const today = planner.range.from;
  const byId = Object.fromEntries(orders.map((o) => [o.id, o]));
  const open = orders.filter((o) => OPEN.includes(o.status));
  const startsToday = new Set((planner.days[0]?.orders ?? []).map((b) => b.id));
  const todayIds = new Set(open.filter((o) => startsToday.has(o.id) || (o.deadline && dateKey(o.deadline, tz) === today)).map((o) => o.id));

  // The scheduler already ranks everything (nextMoves): overdue first, then predicted late, then missing details, then tight, then on track.
  const moves = (planner.nextMoves ?? []).filter((m) => byId[m.orderId]);
  const issues = moves.filter((m) => m.kind in KIND_RANK).sort((a, b) => (KIND_RANK[a.kind] - KIND_RANK[b.kind]) || a.rank - b.rank);
  const missingIds = new Set(issues.filter((m) => m.kind === 'needs_details').map((m) => m.orderId));
  const riskIds = new Set(issues.filter((m) => m.kind !== 'needs_details').map((m) => m.orderId));

  const nowMs = Date.parse(planner.generatedAt);
  const nextDeadline = open.filter((o) => o.deadline && Date.parse(o.deadline) >= nowMs).sort((a, b) => Date.parse(a.deadline) - Date.parse(b.deadline))[0] ?? null;
  return { tz, today, byId, open, todayIds, moves, issues, missingIds, riskIds, attention: issues.length, nextDeadline, top: moves[0] ?? null };
}
