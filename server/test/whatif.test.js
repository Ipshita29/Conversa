// Smart Commitment Management on the ACTUAL five seeded demo orders and the shared workload engine: can an order keep its deadline, what is the
// earliest realistic one, what does moving it do to everyone else. Nothing is saved, nothing is invented: every verdict is the scheduler's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overview, runMove, earliestDeadline, scopeOrders } from '../services/whatIf.js';
import { buildScenarioOrders, demoClock } from '../scripts/demo-data.js';
import { computePlan } from '../services/workloadEngine.js';
import { defaultSettings } from '../config/defaults.js';

const TZ = 'Asia/Kolkata';
const settings = { ...defaultSettings(), timezone: TZ };
const MON_930 = new Date('2026-11-09T04:00:00Z'); // Monday 9 November, 9:30 in the business timezone
const NOW = demoClock(settings); // Tuesday 3 November 2026, 9:00 in the business timezone: production starts
const demo = () => buildScenarioOrders(settings, NOW).map((o, i) => ({ ...o, id: `d${i}` }));
const idOf = (orders, name) => orders.find((o) => o.customerName === name).id;
const hm = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
const NAMES = ['Kartik Singh', 'Aanya Sharma', 'Rohan Mehta', 'Neha Sharma', 'Meera Iyer'];
const o = (id, name, prep, deadline, extra = {}) => ({ id, customerName: name, item: 'Cake', quantity: 1, status: 'confirmed', prepTimeMinutes: prep, deadline: new Date(deadline).toISOString(), notes: null, ...extra });
const at = (h, m = 0, days = 0) => new Date(MON_930.getTime() + days * 86400000 + ((h - 9.5) * 60 + m) * 60000); // a wall-clock time on the test day (IST has no DST)

test('the scope is the five demo orders, or every order, and no made-up customer ever appears', () => {
  const orders = demo();
  const real = o('real', 'Real Customer', 60, at(12, 0, 3));
  assert.deepEqual(scopeOrders([...orders, real], 'demo').map((x) => x.customerName).sort(), [...NAMES].sort());
  assert.equal(scopeOrders([...orders, real], 'all').length, 6);
  const ov = overview({ orders: scopeOrders([...orders, real], 'demo'), settings, now: MON_930 });
  assert.ok(!/Ipshita|Meetu|Kabir/.test(JSON.stringify(ov)));
  assert.deepEqual(ov.cards.map((c) => c.customerName).sort(), [...NAMES].sort());
});

test('can I fulfil this order on time? The overview says which orders keep their deadline, and it does not always say yes', () => {
  const orders = demo(); const ov = overview({ orders, settings, now: NOW });
  const by = Object.fromEntries(ov.cards.map((c) => [c.customerName, c]));
  assert.deepEqual([ov.feasible, ov.overdue, ov.late, ov.conflicts], [true, [], [], 0]);
  for (const n of NAMES) assert.notEqual(by[n].risk, 'high', n);
  for (const x of orders) assert.equal(by[x.customerName].deadline, new Date(x.deadline).toISOString()); // deadlines exactly as seeded
  const tight = orders.map((x) => (x.customerName === 'Aanya Sharma' ? { ...x, prepTimeMinutes: 120 } : x)); // 30 + 120 minutes cannot both finish by 10:30
  const t = overview({ orders: tight, settings, now: NOW });
  assert.equal(t.feasible, false); assert.ok(t.conflicts >= 1); assert.ok(t.late[0].shortfallMinutes > 0);
  const late = overview({ orders, settings, now: new Date('2026-11-03T07:30:00Z') }); // 13:00: four deadlines have already passed
  assert.deepEqual([late.feasible, late.overdue.length], [false, 4]);
});

test('the earliest realistic deadline is found by the scheduler: it can be kept, and nothing sooner can', () => {
  const orders = demo(); const ov = overview({ orders, settings, now: NOW });
  const meera = ov.cards.find((c) => c.customerName === 'Meera Iyer');
  assert.ok(meera.earliest);
  const plan = (deadline) => computePlan({ orders: orders.map((x) => (x.id === meera.id ? { ...x, deadline } : x)), settings, now: NOW });
  const kept = plan(meera.earliest.deadline).results[meera.id];
  assert.notEqual(kept.risk, 'high'); assert.ok(Date.parse(kept.scheduledEnd) <= Date.parse(meera.earliest.deadline)); // independent check with the engine
  const sooner = plan(new Date(Date.parse(meera.earliest.deadline) - 15 * 60000).toISOString()).results[meera.id];
  assert.equal(sooner.risk, 'high'); // a quarter of an hour sooner would be missed
  assert.equal(Date.parse(meera.earliest.deadline) % (15 * 60000), 0); // a promise a person can say out loud
  for (const c of ov.cards) assert.ok(c.earliest && Date.parse(c.earliest.deadline) > NOW.getTime()); // every order gets one, and it is in the future
});

test('the earliest realistic deadline follows the facts: preparation time, other orders and the business hours', () => {
  const orders = demo(); const kabir = idOf(orders, 'Kartik Singh');
  const base = earliestDeadline({ orders, settings, now: NOW, orderId: kabir });
  const longer = earliestDeadline({ orders: orders.map((x) => (x.id === kabir ? { ...x, prepTimeMinutes: 360 } : x)), settings, now: NOW, orderId: kabir });
  assert.ok(Date.parse(longer.deadline) > Date.parse(base.deadline)); // a longer job cannot be promised as soon
  const busier = earliestDeadline({ orders: [...orders, o('x', 'Xavier', 120, '2026-11-03T08:30:00Z')], settings, now: NOW, orderId: idOf(orders, 'Aanya Sharma') });
  const quiet = earliestDeadline({ orders, settings, now: NOW, orderId: idOf(orders, 'Aanya Sharma') });
  assert.ok(Date.parse(busier.deadline) >= Date.parse(quiet.deadline)); // more work in the queue never makes it sooner
  const evening = new Date('2026-11-03T14:00:00Z'); // 7:30 pm: closed until tomorrow
  const e = earliestDeadline({ orders: demo(), settings, now: evening, orderId: idOf(demo(), 'Neha Sharma') });
  assert.ok(Date.parse(e.finish) >= Date.parse('2026-11-04T03:30:00Z')); // nothing can finish before the business opens again at 9:00
  assert.equal(earliestDeadline({ orders: [o('n', 'No Prep', 1, at(12, 0, 1), { prepTimeMinutes: null })], settings, now: MON_930, orderId: 'n' }), null); // cannot be planned
  assert.equal(earliestDeadline({ orders, settings, now: MON_930, orderId: 'nobody' }), null);
});

test('it does not hurt other customers: the earliest deadline for one order never makes a fine order late', () => {
  const orders = [o('a', 'Asha', 120, at(12, 0)), o('b', 'Bela', 120, at(15, 0)), o('c', 'Chandni', 60, at(18, 0))];
  for (const x of orders) {
    const e = earliestDeadline({ orders, settings, now: MON_930, orderId: x.id });
    const plan = computePlan({ orders: orders.map((y) => (y.id === x.id ? { ...y, deadline: e.deadline } : y)), settings, now: MON_930 });
    assert.ok(plan.schedule.every((s) => s.risk !== 'high' || s.orderId === x.id && false), x.customerName); // nobody is late
  }
});

test('move a deadline: a change that still fits is feasible, and shows who it moves; the proposal is unapplied', () => {
  const orders = demo(); const neha = idOf(orders, 'Neha Sharma'); const rohan = idOf(orders, 'Rohan Mehta');
  const r = runMove({ orders, settings, now: NOW, orderId: neha, deadline: '2026-11-03T05:30:00.000Z' }); // the rush order promised for 11:00 instead of 12:00
  assert.deepEqual([r.ok, r.proposal.status, r.proposal.to < r.proposal.from, r.before.feasible, r.after.feasible], [true, 'unapplied', true, true, true]);
  assert.deepEqual(r.affected.map((a) => [a.id, hm(a.wasEnd), hm(a.end)]), [[rohan, '11:30', '12:00']]); // Rohan now waits behind it
  assert.deepEqual(r.newRisks, []);
  assert.deepEqual(r.after.cards.map((c) => [c.customerName, hm(c.start), hm(c.end)]).slice(2, 4), [['Neha Sharma', '10:30', '11:00'], ['Rohan Mehta', '11:00', '12:00']]);
});

test('move a deadline: promising sooner than the schedule can keep is infeasible, and says who misses', () => {
  const orders = demo(); const neha = idOf(orders, 'Neha Sharma');
  const r = runMove({ orders, settings, now: NOW, orderId: neha, deadline: '2026-11-03T05:00:00.000Z' }); // a third order due 10:30: 30 + 60 + 30 minutes in 90
  assert.deepEqual([r.before.feasible, r.after.feasible, r.before.conflicts], [true, false, 0]);
  assert.ok(r.after.conflicts >= 1 && r.after.late[0].shortfallMinutes > 0 && r.newRisks.length >= 1);
});

test('move a deadline: bad requests are refused', () => {
  const orders = demo(); const id = idOf(orders, 'Neha Sharma'); const MON_930 = NOW;
  assert.equal(runMove({ orders, settings, now: MON_930, orderId: 'nobody', deadline: MON_930.toISOString() }).error, 'unknown_order');
  assert.equal(runMove({ orders, settings, now: MON_930, orderId: id, deadline: 'soon' }).error, 'bad_deadline');
  assert.equal(runMove({ orders, settings, now: MON_930, orderId: id, deadline: new Date(MON_930.getTime() - 3600000).toISOString() }).error, 'past');
  assert.equal(runMove({ orders: orders.map((x) => (x.id === id ? { ...x, status: 'completed' } : x)), settings, now: MON_930, orderId: id, deadline: new Date(MON_930.getTime() + 86400000).toISOString() }).error, 'unknown_order');
});

test('every simulation is read-only: orders, durations and deadlines come out exactly as they went in', () => {
  const orders = demo(); const snap = JSON.stringify(orders);
  overview({ orders, settings, now: NOW });
  runMove({ orders, settings, now: NOW, orderId: idOf(orders, 'Kartik Singh'), deadline: new Date(NOW.getTime() + 3600000).toISOString() });
  earliestDeadline({ orders, settings, now: NOW, orderId: idOf(orders, 'Aanya Sharma') });
  assert.equal(JSON.stringify(orders), snap);
});

// ---- The 3 November scenario --------------------------------------------------------------------------------------------------------------
test('3 November: Aanya and Kartik both want 10:30; the scheduler gives Kartik the first, shorter slot and every promise holds', () => {
  const orders = demo(); const ov = overview({ orders: scopeOrders(orders, 'commitment'), settings, now: NOW });
  assert.equal(hm(NOW.toISOString()), '09:00');
  assert.deepEqual(ov.cards.map((c) => [c.customerName, hm(c.start), hm(c.end), hm(c.deadline)]), [
    ['Kartik Singh', '09:00', '09:30', '10:30'], ['Aanya Sharma', '09:30', '10:30', '10:30'], ['Rohan Mehta', '10:30', '11:30', '12:00'],
    ['Neha Sharma', '11:30', '12:00', '12:00'], ['Meera Iyer', '12:00', '13:00', '14:00']]);
  assert.equal(ov.feasible, true); assert.ok(ov.cards.every((c) => Date.parse(c.end) <= Date.parse(c.deadline)));
});

test('3 November: the order of the slots comes from the data, not the page: swap who ordered first and the result is still feasible but different', () => {
  const orders = demo().map((x) => (x.customerName === 'Aanya Sharma' ? { ...x, createdAt: new Date(NOW.getTime() - 40 * 3600000) } : x)); // Aanya now ordered first
  const ov = overview({ orders, settings, now: NOW });
  assert.deepEqual(ov.cards.slice(0, 2).map((c) => [c.customerName, hm(c.start), hm(c.end)]), [['Aanya Sharma', '09:00', '10:00'], ['Kartik Singh', '10:00', '10:30']]);
  assert.equal(ov.feasible, true);
});

// ---- The "commitment" scenario: the five demo orders with their requested times on one production day, on copies --------------------------------
import { scopeInputs } from '../services/whatIf.js';
import { zonedParts } from '../utils/timezone.js';

test('commitment scenario: the same sequence at every hour of two weeks and in several timezones, on a working day, with the orders untouched', () => {
  const t0 = Date.parse('2026-10-19T00:00:00Z');
  for (const timezone of ['Asia/Kolkata', 'America/New_York', 'Pacific/Auckland']) {
    const s = { ...settings, timezone };
    for (let i = 0; i < 24 * 14; i += 3) {
      const now = new Date(t0 + i * 3600000);
      const live = buildScenarioOrders(s, now).map((o, k) => ({ ...o, id: `d${k}` })); // orders as the app holds them (any deadlines)
      const snapshot = JSON.stringify(live);
      const input = scopeInputs(live, 'commitment', s, now);
      const ov = overview({ ...input, settings: s });
      const label = `${now.toISOString()} ${timezone}`;
      assert.ok(input.now >= now, `planning starts in the future: ${label}`);
      const p = zonedParts(input.now, timezone);
      assert.deepEqual([p.hour, p.minute], [9, 0], label);
      assert.ok(s.workingDays.includes(new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()), `working day ${label}`);
      assert.deepEqual(ov.cards.map((c) => c.customerName), ['Kartik Singh', 'Aanya Sharma', 'Rohan Mehta', 'Neha Sharma', 'Meera Iyer'], label);
      assert.deepEqual(ov.cards.map((c) => c.prepTimeMinutes), [30, 60, 60, 30, 60]);
      assert.equal(ov.cards[0].deadline, ov.cards[1].deadline, `Aanya and Kartik share a deadline ${label}`);
      assert.equal(ov.feasible, true, label);
      assert.equal(JSON.stringify(live), snapshot, 'the orders were not modified');
    }
  }
});

test('the other scopes are unchanged: demo = the five orders on the real clock, all = everything', () => {
  const orders = demo(); const real = { id: 'r', customerName: 'Real', item: 'x', notes: null, status: 'pending' };
  const now = new Date('2026-11-05T05:00:00Z');
  const d = scopeInputs([...orders, real], 'demo', settings, now); const all = scopeInputs([...orders, real], 'all', settings, now);
  assert.equal(d.orders.length, 5); assert.equal(all.orders.length, 6); assert.equal(d.now, now); assert.equal(all.now, now);
});

import { commitmentChanges, commitmentApplied, planNow } from '../services/whatIf.js';

test('Apply to Plan helpers: only deadlines differ, applied is recognised, and the plan starts at the applied morning while it is ahead', () => {
  const s = { ...settings, timezone: 'Asia/Kolkata' };
  const now = new Date('2026-11-11T12:30:00Z'); // 18:00 IST on a Wednesday: the scenario is for Thursday morning
  const stored = demo().map((o) => ({ ...o, deadline: new Date(now.getTime() + 40 * 3600000) })); // whatever the orders hold today
  const scenario = scopeInputs(stored, 'commitment', s, now);
  const changes = commitmentChanges(stored, scenario.orders);
  assert.equal(changes.length, 5); assert.ok(changes.every((c) => Object.keys(c).sort().join() === 'customerName,from,id,to'));
  assert.equal(commitmentApplied({ orders: stored, scenario, storedStart: null }), false);
  const applied = stored.map((o) => ({ ...o, deadline: scenario.orders.find((x) => x.id === o.id).deadline }));
  assert.equal(commitmentApplied({ orders: applied, scenario, storedStart: scenario.now }), true);
  assert.equal(commitmentApplied({ orders: applied, scenario, storedStart: new Date(scenario.now.getTime() + 86400000) }), false); // another day's commitment
  assert.equal(commitmentChanges(applied, scenario.orders).length, 0);
  assert.equal(planNow(now, scenario.now).getTime(), scenario.now.getTime()); // production starts at the applied morning
  assert.equal(planNow(new Date(scenario.now.getTime() + 60000), scenario.now).getTime(), scenario.now.getTime() + 60000); // once it has passed, the real clock
  assert.equal(planNow(now, null), now);
});
