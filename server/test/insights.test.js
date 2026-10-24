import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary } from '../services/insightsService.js';
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
