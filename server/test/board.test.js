import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, overdueFor } from '../services/boardService.js';
import { buildDemoOrders, DEMO_MARK } from '../scripts/demo-data.js';
import { defaultSettings } from '../config/defaults.js';

const settings = { ...defaultSettings(), timezone: 'Asia/Kolkata' };
const SUN = new Date('2026-11-03T03:30:00Z'); // Tue 3 Nov 2026, 09:00 in Kolkata: production starts, the demo's day
const withIds = (orders) => orders.map((o, i) => ({ ...o, id: `d${i}` }));
const names = (list) => list.map((x) => x.customerName);
const board = (orders, now = SUN, extra = {}) => buildBoard({ orders, settings, now, ...extra });

test('the demo set is exactly five orders on 3 November, all upcoming when production starts', () => {
  const orders = buildDemoOrders(settings, SUN);
  assert.equal(orders.length, 5); assert.ok(orders.every((o) => o.notes.startsWith(DEMO_MARK)));
  const b = board(withIds(orders));
  assert.deepEqual(b.counts, { overdue: 0, onTrack: 0, upcoming: 5 }); assert.equal(b.total, 5); assert.equal(b.needsDetails.length, 0);
  assert.deepEqual(names(b.sections.upcoming), ['Kartik Singh', 'Aanya Sharma', 'Rohan Mehta', 'Neha Sharma', 'Meera Iyer']); // the production order
  const due = Object.fromEntries(orders.map((o) => [o.customerName, o.deadline.toISOString()]));
  assert.equal(due['Aanya Sharma'], '2026-11-03T05:00:00.000Z'); // 10:30 IST
  assert.equal(due['Kartik Singh'], '2026-11-03T05:00:00.000Z'); // 10:30 IST
  assert.equal(due['Rohan Mehta'], '2026-11-03T06:30:00.000Z'); // 12:00 IST
  assert.equal(due['Neha Sharma'], '2026-11-03T06:30:00.000Z'); // 12:00 IST
  assert.equal(due['Meera Iyer'], '2026-11-03T08:30:00.000Z'); // 14:00 IST
});

test('later in the day the board follows the clock: a deadline that has passed becomes overdue', () => {
  const noon = new Date('2026-11-03T07:30:00Z'); // 13:00 IST: Aanya, Kartik, Rohan and Neha were due before now
  const b = board(withIds(buildDemoOrders(settings, SUN)), noon);
  assert.equal(b.counts.overdue, 4); assert.deepEqual(names(b.sections.upcoming), ['Meera Iyer']);
  assert.match(b.sections.overdue[0].reason, /overdue/);
});

test('classification follows the facts, not the label: new orders land in the right section by themselves', () => {
  const base = withIds(buildDemoOrders(settings, SUN));
  const add = (o) => board([...base, { id: 'new', customerName: 'New', item: 'Cake', quantity: 1, status: 'pending', paymentStatus: 'unverified', prepTimeMinutes: 60, ...o }]);
  const where = (b) => Object.entries(b.sections).find(([, l]) => l.some((x) => x.id === 'new'))?.[0];
  assert.equal(where(add({ deadline: new Date('2026-11-02T04:30:00Z') })), 'overdue'); // deadline passed
  assert.equal(where(add({ deadline: new Date('2026-11-12T11:30:00Z') })), 'onTrack'); // far away and feasible
  assert.equal(where(add({ deadline: new Date('2026-11-04T11:30:00Z') })), 'upcoming'); // due next working day
});

test('an order with too little time is never "on track" just because its deadline is in the future', () => {
  const base = withIds(buildDemoOrders(settings, SUN));
  // 12 hours of work due Wednesday noon, on top of everything already scheduled: far out by the calendar, impossible by the clock.
  const b = board([...base, { id: 'big', customerName: 'Big', item: 'Wedding cake', quantity: 1, status: 'pending', paymentStatus: 'unverified', prepTimeMinutes: 720, deadline: new Date('2026-11-04T06:30:00Z') }]);
  const big = Object.values(b.sections).flat().find((x) => x.id === 'big');
  assert.equal(big.section, 'upcoming'); assert.match(big.reason, /May not finish in time/);
  assert.ok(!b.sections.onTrack.some((x) => x.id === 'big'));
});

test('completed and cancelled orders leave the board; orders missing details are reported, not hidden or guessed', () => {
  const base = withIds(buildDemoOrders(settings, SUN));
  const b = board([...base.map((o, i) => (i === 0 ? { ...o, status: 'completed' } : o)), { id: 'x', customerName: 'Gone', item: 'Cake', status: 'cancelled', prepTimeMinutes: 60, deadline: new Date('2026-10-26T11:30:00Z') }, { id: 'y', customerName: 'Vague', item: 'Tower', status: 'pending', prepTimeMinutes: null, deadline: new Date('2026-10-29T11:30:00Z') }]);
  assert.equal(b.counts.overdue, 0); assert.equal(b.total, 4);
  assert.deepEqual(b.needsDetails.map((x) => [x.customerName, x.reason]), [['Vague', 'missing_prep_time']]);
});

test('overdue ordering and wording: the longest overdue first, in days, hours or minutes', () => {
  assert.equal(overdueFor(26 * 60), '1 day'); assert.equal(overdueFor(3 * 24 * 60 + 5), '3 days'); assert.equal(overdueFor(5 * 60 + 20), '5 hours'); assert.equal(overdueFor(20), '20 minutes'); assert.equal(overdueFor(0), '1 minute');
  const mk = (id, hoursAgo) => ({ id, customerName: id, item: 'Cake', quantity: 1, status: 'pending', prepTimeMinutes: 30, deadline: new Date(SUN.getTime() - hoursAgo * 3600000) });
  const b = board([mk('recent', 5), mk('oldest', 60), mk('middle', 30)]);
  assert.deepEqual(names(b.sections.overdue), ['oldest', 'middle', 'recent']);
});

test('real and demo orders are scheduled separately, so neither takes the other\'s capacity', () => {
  const demo = withIds(buildDemoOrders(settings, SUN));
  const real = [{ id: 'r1', customerName: 'Real', item: 'Cake', quantity: 1, status: 'pending', prepTimeMinutes: 360, deadline: new Date('2026-11-03T05:00:00Z') }];
  const demoOnly = board([...demo, ...real], SUN, { dataset: 'demo' });
  assert.deepEqual(demoOnly.counts, { overdue: 0, onTrack: 0, upcoming: 5 }); // the real order does not disturb the demo story
  assert.deepEqual(board([...demo, ...real], SUN, { dataset: 'real' }).total, 1);
  assert.deepEqual([demoOnly.datasets.real, demoOnly.datasets.demo], [1, 5]);
});
