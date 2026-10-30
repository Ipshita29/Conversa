import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary, checkCustomRange, RANGES } from '../services/insightsService.js';
import { validateOrderInput } from '../utils/validation.js';
import { defaultSettings } from '../config/defaults.js';

const settings = { ...defaultSettings(), timezone: 'Asia/Kolkata' };
const NOW = new Date('2026-10-23T06:00:00Z'); // Fri 23 Oct 2026, 11:30 in Kolkata
const D = 86400000;
let n = 0;
const order = (daysAgo, f = {}) => ({ id: `o${++n}`, customerName: `C${n}`, item: 'Brownie tray', quantity: 1, status: 'pending', paymentStatus: 'unverified', prepTimeMinutes: 60, price: 500, deadline: new Date(NOW.getTime() + 5 * D).toISOString(), createdAt: new Date(NOW.getTime() - daysAgo * D).toISOString(), ...f });
const sum = (orders, o = {}) => buildSummary({ orders, settings, days: 7, now: NOW, ...o });

test('price is an optional non-negative number for the whole order', () => {
  assert.equal(validateOrderInput({ customerName: 'A', item: 'B', price: 450.5 }).value.price, 450.5);
  assert.equal(validateOrderInput({ customerName: 'A', item: 'B', price: null }).value.price, null);
  for (const bad of [-1, '300', Number.NaN]) assert.equal(validateOrderInput({ customerName: 'A', item: 'B', price: bad }).details[0].field, 'price');
});

test('revenue, orders and average order value count each order once and leave cancelled orders out', () => {
  const orders = [order(1), order(2, { price: 1000 }), order(3, { status: 'cancelled', price: 9999 }), order(40, { price: 777 })]; // the last is outside 7 days
  const k = sum(orders).kpis;
  assert.equal(k.totalOrders.value, 2); assert.equal(k.totalRevenue.value, 1500); assert.equal(k.averageOrderValue.value, 750);
  assert.equal(k.completedOrders.value, 0);
});

test('unpriced orders are never guessed: revenue is unavailable with none priced, and partial with some', () => {
  const none = sum([order(1, { price: null }), order(2, { price: null })]).kpis;
  assert.equal(none.totalRevenue.available, false); assert.match(none.totalRevenue.reason, /price/); assert.equal(none.averageOrderValue.available, false);
  assert.equal(none.totalOrders.value, 2);
  const some = sum([order(1, { price: 400 }), order(2, { price: null })]).kpis;
  assert.equal(some.totalRevenue.value, 400); assert.equal(some.totalRevenue.unpricedOrders, 1); assert.equal(some.averageOrderValue.value, 400);
});

test('comparison with the previous period appears only when there is enough history to be fair', () => {
  const few = sum([order(1), order(2), order(9)]).kpis; // one order in the previous 7 days
  assert.equal(few.totalOrders.comparison.available, false); assert.match(few.totalOrders.comparison.reason, /fewer than 3/);
  const enough = sum([order(1), order(2), order(8), order(9), order(10), order(11)]).kpis; // 4 before, 2 now
  assert.equal(enough.totalOrders.comparison.available, true); assert.equal(enough.totalOrders.comparison.previous, 4); assert.equal(enough.totalOrders.comparison.change, -50);
  assert.equal(enough.totalRevenue.comparison.change, -50);
});

test('the trend has one entry per day with real totals, 7 or 30 days', () => {
  const s = sum([order(0, { price: 300 }), order(0, { price: 200 }), order(3)]);
  assert.equal(s.trend.length, 7); assert.equal(s.trend.at(-1).date, '2026-10-23');
  assert.deepEqual([s.trend.at(-1).orders, s.trend.at(-1).revenue], [2, 500]);
  assert.equal(s.trend.reduce((t, d) => t + d.orders, 0), 3);
  assert.equal(sum([order(20)], { days: 30 }).trend.length, 30);
  assert.equal(sum([order(20)], { days: 30 }).kpis.totalOrders.value, 1);
});

test('top products are ranked by units sold, with units, orders and revenue; unpriced revenue is null', () => {
  const orders = [order(1, { item: 'Cupcakes (box)', quantity: 24, price: 600 }), order(2, { item: 'cupcakes', quantity: 12, price: null }), order(1, { item: 'Brownie tray', quantity: 2 }), order(2, { item: 'Cake', quantity: 1 }), order(2, { item: 'Cookies', quantity: 5 })];
  const top = sum(orders).topProducts;
  assert.equal(top.length, 3);
  assert.deepEqual(top.map((p) => [p.product.toLowerCase(), p.units]), [['cupcakes', 36], ['cookies', 5], ['brownie tray', 2]]);
  assert.equal(top[0].orders, 2); assert.equal(top[0].revenue, 600); assert.equal(top[0].partial, true);
});

test('insights come only from the data: a clear busiest day, a clear best seller, the scheduler\'s overload, and missing prices', () => {
  // Fri 23 Oct 2026: three orders arrive on Tuesday 20 Oct, one each on other days.
  const light = { prepTimeMinutes: 20 }; // small jobs, so the scheduler sees no overload here
  const orders = [order(3, light), order(3, light), order(3, light), order(1, { item: 'Cake', ...light }), order(2, { item: 'Cookies', ...light }), order(0, { item: 'Brownie tray', price: null, ...light })];
  const ids = sum(orders).insights.map((i) => i.id);
  assert.ok(ids.includes('busiest-day')); assert.ok(ids.includes('best-seller')); assert.ok(ids.includes('missing-prices'));
  const busy = sum(orders).insights.find((i) => i.id === 'busiest-day');
  assert.match(busy.title, /Tuesday/); assert.match(busy.finding, /3 of 6/); assert.ok(busy.action.length > 10 && busy.link.to);
  assert.ok(sum(orders).insights.length <= 3);
  assert.deepEqual(sum([order(1)]).insights.map((i) => i.id), []); // one order is not enough to say anything
  const crowded = Array.from({ length: 6 }, () => order(1, { prepTimeMinutes: 360, deadline: new Date(NOW.getTime() + 2 * D).toISOString() }));
  assert.ok(sum(crowded).insights.some((i) => i.id === 'overload'));
});

test('real and demo orders never mix unless asked', () => {
  const orders = [order(1), order(1, { notes: '[DEMO] sample' }), order(2, { notes: '[DEMO] sample' })];
  assert.equal(sum(orders, { dataset: 'real' }).kpis.totalOrders.value, 1);
  assert.equal(sum(orders, { dataset: 'demo' }).kpis.totalOrders.value, 2);
  assert.equal(sum(orders).kpis.totalOrders.value, 3);
  assert.deepEqual([sum(orders).datasets.real, sum(orders).datasets.demo], [1, 2]);
});

// ---- Delivery performance, status split, ranges (the Insights dashboard) -------------------------------------------------
const delivered = (daysAgo, { late = false, ...f } = {}) => {
  const deadline = new Date(NOW.getTime() - daysAgo * D + D); // promised a day after "completion day"
  const completedAt = new Date(deadline.getTime() + (late ? 3600000 : -3600000));
  return order(daysAgo + 1, { status: 'completed', deadline, completedAt, ...f });
};

test('on-time delivery uses only really delivered orders: completedAt against the promised deadline, never open ones', () => {
  const list = [delivered(1), delivered(2), delivered(3, { late: true }), order(1), order(2, { status: 'in_progress', deadline: new Date(NOW.getTime() - D) })]; // open + overdue orders are NOT late deliveries
  const r = sum(list);
  assert.deepEqual(r.timing, { delivered: 3, onTime: 2, delayed: 1 });
  assert.equal(r.kpis.onTimeRate.available, true); assert.equal(r.kpis.onTimeRate.value, 67); assert.equal(r.kpis.onTimeRate.onTime, 2);
});

test('on-time rate appears with any real delivered order, and is unavailable (so the dashboard hides it) with none', () => {
  const one = sum([delivered(1)]).kpis.onTimeRate;
  assert.equal(one.available, true); assert.equal(one.value, 100); assert.equal(one.delivered, 1); assert.equal(one.comparison.available, false); // no previous period to compare with
  assert.equal(sum([delivered(1), delivered(2, { late: true })]).kpis.onTimeRate.value, 50);
  assert.equal(sum([order(1)]).kpis.onTimeRate.available, false); // nothing delivered at all
  const unknown = sum([1, 2, 3, 4].map((d) => order(d, { status: 'completed', completedAt: null }))); // completed before completion time was recorded
  assert.equal(unknown.kpis.onTimeRate.available, false); assert.equal(unknown.timing.delivered, 0);
  const noDeadline = sum([1, 2, 3].map((d) => delivered(d, { deadline: null })));
  assert.equal(noDeadline.timing.delivered, 0); assert.equal(noDeadline.kpis.onTimeRate.available, false);
  const open = sum([order(1, { status: 'in_progress', deadline: new Date(NOW.getTime() - D) }), order(2, { status: 'cancelled' }), order(3, { status: 'pending' })]);
  assert.equal(open.timing.delivered, 0); assert.equal(open.timing.delayed, 0); // open, cancelled and pending orders are never delayed deliveries
});

test('delivery is placed in the period by its completion day, and compared only with enough history', () => {
  const inPeriod = [delivered(1), delivered(2), delivered(3)];
  const before = [delivered(8), delivered(9, { late: true }), delivered(10)];
  const k = sum([...inPeriod, ...before]).kpis.onTimeRate;
  assert.equal(k.value, 100); assert.equal(k.comparison.available, true); assert.equal(k.comparison.previous, 67); assert.equal(k.comparison.change, 33);
  assert.equal(sum(inPeriod).kpis.onTimeRate.comparison.available, false);
});

test('order status groups are mutually exclusive and add up to the total (cancelled included)', () => {
  const list = [order(1, { status: 'completed', completedAt: NOW }), order(2, { status: 'cancelled' }), order(2), order(3, { status: 'in_progress' }), order(4, { deadline: new Date(NOW.getTime() - D) })];
  const s = sum(list).status;
  assert.equal(s.total, 5); assert.equal(s.completed + s.cancelled + s.atRisk + s.pending, s.total);
  assert.equal(s.completed, 1); assert.equal(s.cancelled, 1); assert.ok(s.atRisk >= 1); // the overdue open order is at risk
  assert.equal(sum([order(1, { deadline: new Date(NOW.getTime() + 20 * D) })]).status.atRisk, 0);
});

test('three months and a custom period work; bad periods are described, and the previous period matches in length', () => {
  assert.deepEqual(RANGES, [7, 30, 90]);
  const r90 = sum([order(80)], { days: 90 });
  assert.equal(r90.trend.length, 90); assert.equal(r90.kpis.totalOrders.value, 1);
  const c = sum([order(3), order(12)], { from: '2026-10-10', to: '2026-10-16' });
  assert.equal(c.range.days, 7); assert.equal(c.range.from, '2026-10-10'); assert.equal(c.kpis.totalOrders.value, 1); // only the order received on Oct 11
  const today = { year: 2026, month: 10, day: 23 };
  assert.equal(checkCustomRange('2026-10-10', '2026-10-16', today).details.length, 0);
  assert.equal(checkCustomRange('2026-10-16', '2026-10-10', today).details[0].field, 'from');
  assert.equal(checkCustomRange('2026-10-10', '2026-12-01', today).details[0].field, 'to'); // not in the future
  assert.equal(checkCustomRange('2024-01-01', '2026-10-10', today).details[0].field, 'from'); // over a year
  assert.equal(checkCustomRange('2026-02-30', '2026-03-01', today).details[0].field, 'from'); // not a real date
});

test('products are ranked with revenue and units available, unpriced products never get an invented revenue', () => {
  const r = sum([order(1, { item: 'Cake', price: 900, quantity: 1 }), order(2, { item: 'Cookies', price: 300, quantity: 20 }), order(2, { item: 'Cookies', price: 300, quantity: 20 }), order(3, { item: 'Mystery', price: null })]);
  assert.equal(r.products[0].product, 'Cake'); assert.equal(r.products[1].revenue, 600);
  assert.equal(r.products.find((p) => p.product === 'Mystery').revenue, null);
  assert.equal(r.products.at(-1).product, 'Mystery'); // unpriced sorts last by revenue
});

test('an approaching deadline becomes an insight only when the scheduler really flags it', () => {
  const overdue = sum([order(2, { status: 'in_progress', deadline: new Date(NOW.getTime() - D) })]);
  assert.ok(overdue.insights.some((i) => i.id === 'deadline-risk' && i.link.to === '/plan'));
  const calm = sum([order(1, { deadline: new Date(NOW.getTime() + 20 * D), prepTimeMinutes: 30 })]);
  assert.ok(!calm.insights.some((i) => i.id === 'deadline-risk'));
});
