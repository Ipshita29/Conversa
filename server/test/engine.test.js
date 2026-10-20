import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePlan, simulate } from '../services/workloadEngine.js';
import { buildDashboard } from '../services/dashboardService.js';
import { ApiError } from '../utils/errors.js';

// Mon-Fri 09:00-17:00 UTC, 6h productive capacity, 4h "medium" buffer. "now" is Monday 2026-10-19 00:00 UTC.
const settings = { timezone: 'UTC', workingDays: [1, 2, 3, 4, 5], workStart: '09:00', workEnd: '17:00', dailyCapacityMinutes: 360, riskBufferMinutes: 240, customisationMinutes: 30, prepRules: [] };
const now = new Date('2026-10-19T00:00:00Z');
let n = 0;
const order = (o) => ({ id: `o${++n}`, customerName: 'C', item: 'I', status: 'pending', paymentStatus: 'verified', prepTimeMinutes: 60, deadline: '2026-10-23T17:00:00Z', ...o });
const plan = (orders, extra = {}) => computePlan({ orders, settings, now, rangeDays: 7, ...extra });

test('completed and cancelled orders are excluded from pending workload and schedule', () => {
  const p = plan([order({ prepTimeMinutes: 100 }), order({ status: 'completed', prepTimeMinutes: 500 }), order({ status: 'cancelled', prepTimeMinutes: 500 })]);
  assert.equal(p.workload.pendingMinutes, 100);
  assert.equal(p.days.flatMap((d) => d.orders).length, 1);
  assert.equal(p.schedule.length, 1);
});

test('pending workload is reported in minutes and hours; available capacity skips non-working days', () => {
  const p = plan([order({ prepTimeMinutes: 90 })], { rangeDays: 7 });
  assert.equal(p.workload.pendingMinutes, 90);
  assert.equal(p.workload.pendingHours, 1.5);
  assert.equal(p.workload.availableMinutes, 5 * 360); // Mon-Fri only
  assert.equal(p.days.find((d) => d.date === '2026-10-24').capacityMinutes, 0); // Saturday
});

test('orders missing prep time or deadline are unscheduled, not guessed', () => {
  const p = plan([order({ prepTimeMinutes: null }), order({ deadline: null }), order({ prepTimeMinutes: null, deadline: null })]);
  assert.deepEqual(p.unscheduledOrders.map((u) => u.reason), ['missing_prep_time', 'missing_deadline', 'missing_both']);
  assert.equal(p.schedule.length, 0);
  assert.equal(p.workload.pendingMinutes, 60); // only the one with a known prep time
});

test('overloaded day: second large order spills over and misses its deadline (high risk, with shortfall)', () => {
  const a = order({ prepTimeMinutes: 300, deadline: '2026-10-19T17:00:00Z' });
  const b = order({ prepTimeMinutes: 300, deadline: '2026-10-19T17:00:00Z' });
  const p = plan([a, b]);
  assert.equal(p.overloadedDays[0].date, '2026-10-19');
  const risky = p.risks.filter((r) => r.risk === 'high');
  assert.equal(risky.length, 1);
  assert.ok(risky[0].shortfallMinutes > 0);
  assert.ok(risky[0].suggestedDeadline);
  assert.equal(p.recommendations[0].priority, 'high');
});

test('conflicting deadlines are scheduled earliest-deadline-first', () => {
  const late = order({ prepTimeMinutes: 200, deadline: '2026-10-21T17:00:00Z' });
  const early = order({ prepTimeMinutes: 200, deadline: '2026-10-19T17:00:00Z' });
  const p = plan([late, early]);
  const monday = p.days[0].orders.map((o) => o.id);
  assert.equal(monday[0], early.id);
});

test('risk levels: low with plenty of slack, medium with a thin buffer, high when the deadline has passed', () => {
  const low = plan([order({ prepTimeMinutes: 60, deadline: '2026-10-23T17:00:00Z' })]);
  assert.equal(low.schedule[0].risk, 'low');
  // 300 min from 09:00 finishes 14:00 -> 180 min buffer < 240
  const medium = plan([order({ prepTimeMinutes: 300, deadline: '2026-10-19T17:00:00Z' })]);
  assert.equal(medium.schedule[0].risk, 'medium');
  const passed = plan([order({ deadline: '2026-10-18T10:00:00Z' })]);
  assert.equal(passed.schedule[0].risk, 'high');
  assert.match(passed.recommendations[0].action, /missed deadline/);
});

test("today's capacity is limited to the time left in the working window", () => {
  const p = computePlan({ orders: [], settings, now: new Date('2026-10-19T15:00:00Z'), rangeDays: 1 });
  assert.equal(p.days[0].capacityMinutes, 120); // 15:00-17:00
});

test('work that does not fit before the weekend continues on the next working day', () => {
  const fri = new Date('2026-10-23T09:00:00Z');
  const p = computePlan({ orders: [order({ prepTimeMinutes: 500, deadline: '2026-10-30T17:00:00Z' })], settings, now: fri, rangeDays: 7 });
  const dates = p.days.filter((d) => d.plannedMinutes > 0).map((d) => d.date);
  assert.deepEqual(dates, ['2026-10-23', '2026-10-26']);
});

test('an order too large for the whole horizon is high risk and recommended for deferral', () => {
  const p = plan([order({ prepTimeMinutes: 60 * 24 * 30, deadline: '2026-10-30T17:00:00Z' })]);
  assert.equal(p.schedule[0].risk, 'high');
  assert.equal(p.schedule[0].scheduledEnd, null);
  assert.match(p.recommendations[0].action, /Defer or decline/);
});

test('simulation returns before/after workload, new risks and suggestions, and does not mutate the inputs', () => {
  const existing = [order({ prepTimeMinutes: 300, deadline: '2026-10-19T17:00:00Z' })];
  const snapshot = JSON.stringify(existing);
  const sim = simulate({
    orders: existing, settings, now, rangeDays: 7,
    changes: [{ type: 'add_order', order: { customerName: 'New', item: 'Big', prepTimeMinutes: 300, deadline: '2026-10-19T17:00:00Z' } }],
  });
  assert.equal(JSON.stringify(existing), snapshot);
  assert.equal(sim.simulated, true);
  assert.equal(sim.comparison.pendingMinutesDelta, 300);
  assert.equal(sim.comparison.currentWorkload.pendingMinutes, 300);
  assert.equal(sim.comparison.simulatedWorkload.pendingMinutes, 600);
  assert.ok(sim.comparison.newRisks.some((r) => r.orderId === 'change_0' || r.risk === 'high'));
  assert.ok(sim.comparison.conflicts.length >= 1);
  assert.ok(sim.comparison.suggestedAdjustments.length >= 1);
});

test('simulation: changing a deadline can resolve a risk; cancelling frees capacity', () => {
  const a = order({ prepTimeMinutes: 300, deadline: '2026-10-19T17:00:00Z' });
  const b = order({ prepTimeMinutes: 300, deadline: '2026-10-19T17:00:00Z' });
  const moved = simulate({ orders: [a, b], settings, now, changes: [{ type: 'update_order', orderId: b.id, order: { deadline: '2026-10-23T17:00:00Z' } }] });
  assert.ok(moved.comparison.resolvedRisks.length >= 1);
  const cancelled = simulate({ orders: [a, b], settings, now, changes: [{ type: 'cancel_order', orderId: b.id }] });
  assert.equal(cancelled.comparison.pendingMinutesDelta, -300);
});

test('simulation validates its input', () => {
  const base = { orders: [order()], settings, now };
  const code = (changes) => { try { simulate({ ...base, changes }); } catch (e) { assert.ok(e instanceof ApiError); return e.status; } return 200; };
  assert.equal(code(undefined), 422);
  assert.equal(code([]), 422);
  assert.equal(code([{ type: 'explode' }]), 422);
  assert.equal(code([{ type: 'add_order', order: { item: 'x' } }]), 422); // missing customerName
  assert.equal(code([{ type: 'add_order', order: { customerName: 'a', item: 'b', quantity: -1 } }]), 422);
  assert.equal(code([{ type: 'update_order', orderId: 'nope', order: {} }]), 404);
  assert.equal(code([{ type: 'update_order', orderId: base.orders[0].id, order: { deadline: 'tomorrow' } }]), 422);
});

test('dashboard and planner use the same workload numbers', () => {
  const orders = [order({ prepTimeMinutes: 120 }), order({ prepTimeMinutes: 300, deadline: '2026-10-19T17:00:00Z' }), order({ status: 'completed' }), order({ status: 'in_progress', prepTimeMinutes: 30 })];
  const p = plan(orders);
  const d = buildDashboard(orders, settings, now);
  assert.equal(d.workload.pendingMinutes, p.workload.pendingMinutes);
  assert.equal(d.workload.availableMinutes, p.workload.availableMinutes);
  assert.deepEqual(d.workload.daily, p.days.map(({ date, plannedMinutes, capacityMinutes }) => ({ date, plannedMinutes, capacityMinutes })));
  assert.deepEqual(d.stats, { total: 4, pending: 2, inProgress: 1, completed: 1, atRisk: d.stats.atRisk });
  assert.equal(d.stats.atRisk, p.risks.length);
});
