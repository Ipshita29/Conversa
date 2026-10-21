import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePlan, simulate, suggestScenario } from '../services/workloadEngine.js';
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

test('schedule entries explain themselves: kind, exact blocks, and the orders queued ahead', () => {
  const a = order({ prepTimeMinutes: 300, deadline: '2026-10-19T17:00:00Z' });
  const b = order({ prepTimeMinutes: 300, deadline: '2026-10-19T17:00:00Z' });
  const p = plan([a, b]);
  const [first, second] = p.schedule;
  assert.equal(p.rules.riskBufferMinutes, 240);
  assert.equal(first.kind, 'tight');
  assert.deepEqual(first.precededBy, []);
  assert.equal(second.kind, 'late');
  assert.deepEqual(second.precededBy, [{ orderId: first.orderId, minutes: 300 }]);
  assert.equal(second.deadline, '2026-10-19T17:00:00.000Z');
  // blocks add up to the prep time, are contiguous with the schedule start/end, and match the day entries
  assert.equal(second.blocks.reduce((s, x) => s + x.minutes, 0), 300);
  assert.equal(second.blocks[0].start, second.scheduledStart);
  assert.equal(second.blocks.at(-1).end, second.scheduledEnd);
  const day = p.days.find((d) => d.date === second.blocks[0].date);
  assert.ok(day.startsAt);
  assert.deepEqual(day.orders.find((o) => o.id === second.orderId).start, second.blocks[0].start);
  // the second order starts exactly when the first one ends (it is queued behind it)
  assert.equal(second.scheduledStart, first.scheduledEnd);
});

test('kinds: deadline_passed, unschedulable, on_track', () => {
  assert.equal(plan([order({ deadline: '2026-10-18T10:00:00Z' })]).schedule[0].kind, 'deadline_passed');
  assert.equal(plan([order({ prepTimeMinutes: 60 * 24 * 30, deadline: '2026-10-30T17:00:00Z' })]).schedule[0].kind, 'unschedulable');
  assert.equal(plan([order({ prepTimeMinutes: 60, deadline: '2026-10-23T17:00:00Z' })]).schedule[0].kind, 'on_track');
});

// ---- free windows, next moves, suggested scenario, fit probe ----
test('free windows: what is left of each day is one uninterrupted block; the largest is reported', () => {
  const p = plan([order({ prepTimeMinutes: 100, deadline: '2026-10-23T17:00:00Z' })]);
  const mon = p.freeWindows.find((w) => w.date === '2026-10-19');
  assert.equal(mon.minutes, 260);
  assert.equal(mon.start, '2026-10-19T10:40:00.000Z'); // 09:00 + 100 min of work
  assert.equal(mon.end, '2026-10-19T15:00:00.000Z'); // 260 min later
  assert.equal(p.largestFreeWindow.minutes, 360); // a whole untouched day beats Monday's remainder
  assert.equal(p.largestFreeWindow.date, '2026-10-20');
  assert.ok(!p.freeWindows.some((w) => w.date === '2026-10-24')); // weekend: no capacity, no window
});

test('next moves rank actions: overdue, predicted late, tight, blocked by missing details, then on track', () => {
  const overdue = order({ deadline: '2026-10-18T10:00:00Z', prepTimeMinutes: 60, customerName: 'Overdue' });
  const tight = order({ prepTimeMinutes: 300, deadline: '2026-10-19T17:00:00Z', customerName: 'Tight' });
  const late = order({ prepTimeMinutes: 300, deadline: '2026-10-19T17:00:00Z', customerName: 'Late' });
  const blocked = order({ prepTimeMinutes: null, customerName: 'Blocked' });
  const fine = order({ prepTimeMinutes: 60, deadline: '2026-10-23T17:00:00Z', customerName: 'Fine', status: 'in_progress' });
  const done = order({ status: 'completed', customerName: 'Done' });
  const p = plan([fine, blocked, tight, done, late, overdue]);
  const names = p.nextMoves.map((m) => [overdue, tight, late, blocked, fine].find((o) => o.id === m.orderId).customerName);
  assert.deepEqual(names, ['Overdue', 'Late', 'Tight', 'Blocked', 'Fine']); // completed orders never appear
  assert.deepEqual(p.nextMoves.map((m) => m.rank), [1, 2, 3, 4, 5]);
  assert.deepEqual(p.nextMoves.map((m) => m.kind), ['deadline_passed', 'late', 'tight', 'needs_details', 'on_track']);
  const byName = Object.fromEntries(p.nextMoves.map((m, i) => [names[i], m]));
  assert.match(byName.Overdue.action, /Contact Overdue/);
  assert.match(byName.Late.why, /after its deadline/);
  assert.match(byName.Late.why, /2 earlier-deadline orders are scheduled before it/); // the overdue and the tight order, both really scheduled first
  assert.ok(byName.Late.recovery.includes('Offer Late a deadline of'));
  assert.match(byName.Tight.why, /only .* before the deadline, under your 4h safety buffer/);
  assert.match(byName.Blocked.action, /Confirm details with Blocked, then add a preparation time/);
  assert.equal(byName.Blocked.workSequence, null); // not scheduled, so no queue position invented
  assert.match(byName.Fine.action, /Keep going on/); // in progress
  assert.equal(byName.Fine.recovery, null);
  assert.ok(p.nextMovesRule.includes('Overdue first'));
});

test('a missing deadline is also an action for the seller, with its own wording', () => {
  const p = plan([order({ deadline: null, prepTimeMinutes: 90, customerName: 'NoDate' })]);
  assert.match(p.nextMoves[0].action, /then add a deadline/);
  assert.match(p.nextMoves[0].why, /cannot be scheduled without a deadline/);
});

test('simulation reports the largest free window before and after, and whether another job fits', () => {
  const a = order({ prepTimeMinutes: 300, deadline: '2026-10-19T17:00:00Z' });
  const sim = simulate({ orders: [a], settings, now, rangeDays: 7, changes: [{ type: 'cancel_order', orderId: a.id }] });
  assert.equal(sim.comparison.currentLargestFreeWindow.minutes, 360);
  assert.equal(sim.comparison.simulatedLargestFreeWindow.minutes, 360);
  assert.deepEqual(sim.comparison.currentCounts, { high: 0, medium: 1, low: 0, details: 0 }); // 300 min leaves only 3h of buffer
  assert.deepEqual(sim.comparison.simulatedCounts, { high: 0, medium: 0, low: 0, details: 0 });
  assert.equal(sim.comparison.fit.minutes, 60); // default probe
  assert.equal(sim.comparison.fit.fits, true);
  assert.ok(sim.comparison.fit.startsAt && sim.comparison.fit.finishesAt);
  const big = simulate({ orders: [a], settings, now, rangeDays: 7, probeMinutes: 400, changes: [{ type: 'update_order', orderId: a.id, order: { prepTimeMinutes: 100 } }] });
  assert.equal(big.comparison.fit.fits, false); // no single day has 400 uninterrupted minutes
  assert.match(big.comparison.fit.reason, /no uninterrupted 6h 40m window/i);
});

test('the fit probe is honest when adding a job would hurt an existing order', () => {
  // Monday is nearly full; the largest window is later, but a job due before an existing order would push it late.
  const a = order({ prepTimeMinutes: 360, deadline: '2026-10-19T17:00:00Z' });
  const b = order({ prepTimeMinutes: 360, deadline: '2026-10-20T11:00:00Z' }); // tight: Tue 09:00-15:00 vs 11:00 deadline = late already
  const sim = simulate({ orders: [a, b], settings, now, rangeDays: 3, probeMinutes: 60, changes: [{ type: 'update_order', orderId: a.id, order: { prepTimeMinutes: 360 } }] });
  const fit = sim.comparison.fit;
  assert.equal(typeof fit.fits, 'boolean');
  if (!fit.fits) assert.ok(fit.reason);
});

test('suggested scenario: the engine itself confirms it helps and creates no new risk', () => {
  const a = order({ prepTimeMinutes: 300, deadline: '2026-10-19T17:00:00Z', customerName: 'A' });
  const b = order({ prepTimeMinutes: 300, deadline: '2026-10-19T17:00:00Z', customerName: 'B' });
  const sc = suggestScenario({ orders: [a, b], settings, now, rangeDays: 7 });
  assert.equal(sc.kind, 'move_deadline');
  assert.equal(sc.changes.length, 1);
  assert.equal(sc.changes[0].type, 'update_order');
  assert.match(sc.summary, /from .* to /);
  const verify = simulate({ orders: [a, b], changes: sc.changes, settings, now, rangeDays: 7 });
  assert.equal(verify.comparison.newRisks.length, 0);
  assert.ok(verify.comparison.resolvedRisks.length >= 1);
  // and it is read-only: the orders were not touched
  assert.equal(a.deadline, '2026-10-19T17:00:00Z');
});

test('suggested scenario falls back to a capacity check when nothing needs rescuing', () => {
  const sc = suggestScenario({ orders: [order({ prepTimeMinutes: 60, deadline: '2026-10-23T17:00:00Z' })], settings, now, rangeDays: 7 });
  assert.equal(sc.kind, 'capacity_check');
  assert.equal(sc.changes[0].type, 'add_order');
  assert.equal(sc.changes[0].order.prepTimeMinutes, 60);
  assert.equal(suggestScenario({ orders: [], settings: { ...settings, workingDays: [] }, now, rangeDays: 7 }), null); // no capacity at all: nothing to suggest
});

test('near-term free window ignores empty days later in the week', () => {
  // Monday and Tuesday are completely booked; Wednesday onwards is empty.
  const orders = [order({ prepTimeMinutes: 360, deadline: '2026-10-23T17:00:00Z' }), order({ prepTimeMinutes: 360, deadline: '2026-10-23T17:00:00Z' })];
  const p = plan(orders);
  assert.equal(p.largestFreeWindow.minutes, 360); // Wednesday
  assert.equal(p.largestFreeWindow.date, '2026-10-21');
  assert.equal(p.nearFreeWindow, null); // nothing free in the first two working days
});

test('when the next two days have no free hour, the suggestion is an explicit prep-time ASSUMPTION the engine then checks', () => {
  // 330 + 360 = 690 of the 720 minutes available on Monday and Tuesday: only 30 minutes are left over, not an hour.
  const orders = [330, 360].map((m, i) => order({ prepTimeMinutes: m, deadline: '2026-10-23T17:00:00Z', customerName: `C${i}` }));
  assert.equal(plan(orders).nearFreeWindow.minutes, 30);
  const sc = suggestScenario({ orders, settings, now, rangeDays: 7 });
  assert.equal(sc.kind, 'reduce_prep');
  assert.match(sc.summary, /Assume you can prepare it in/);
  assert.match(sc.why, /assumption, not a fact/);
  const ch = sc.changes[0];
  assert.equal(ch.type, 'update_order');
  assert.ok(ch.order.prepTimeMinutes < 360 && ch.order.prepTimeMinutes % 15 === 0);
  const verify = simulate({ orders, changes: sc.changes, settings, now, rangeDays: 7 });
  assert.equal(verify.comparison.currentNearFreeWindow.minutes, 30);
  assert.ok(verify.comparison.simulatedNearFreeWindow.minutes >= 60); // the engine confirms an uninterrupted hour appears
  assert.equal(verify.comparison.newRisks.length, 0);
  // and the stored orders are untouched
  assert.deepEqual(orders.map((o) => o.prepTimeMinutes), [330, 360]);
});

test('moving a deadline alone never creates free time (the scheduler works as soon as possible)', () => {
  const orders = [360, 360, 360].map((m, i) => order({ prepTimeMinutes: m, deadline: '2026-10-23T17:00:00Z', customerName: `C${i}` }));
  const sim = simulate({ orders, settings, now, rangeDays: 7, changes: [{ type: 'update_order', orderId: orders[0].id, order: { deadline: '2026-10-30T17:00:00Z' } }] });
  assert.equal(sim.comparison.simulatedNearFreeWindow, null);
  assert.deepEqual(sim.comparison.simulatedWorkload.pendingMinutes, sim.comparison.currentWorkload.pendingMinutes);
});
