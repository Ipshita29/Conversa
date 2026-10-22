import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMonthly, isMonth } from '../services/analyticsService.js';
import { defaultSettings } from '../config/defaults.js';

const settings = { ...defaultSettings(), timezone: 'Asia/Kolkata' };
const now = new Date('2026-10-22T06:00:00Z');
let n = 0;
const o = (f) => ({ id: `o${++n}`, customerName: 'A', item: 'Cake', quantity: 1, status: 'pending', paymentStatus: 'unverified', prepTimeMinutes: 60, deadline: '2026-10-30T10:00:00Z', createdAt: '2026-10-05T10:00:00Z', ...f });

test('month validation', () => {
  assert.ok(isMonth('2026-10')); assert.ok(!isMonth('2026-13')); assert.ok(!isMonth('2026-1')); assert.ok(!isMonth(undefined));
});

test('metrics the data model cannot support are reported as unavailable, never as numbers', () => {
  const r = buildMonthly({ orders: [o({})], settings, month: '2026-10', now });
  for (const m of [r.overview.revenue, r.overview.outstandingBalance, r.overview.onTimeRate, r.sales.weeklyRevenue, r.sales.averageOrderValue, r.fulfilment.averageFulfilmentTime, r.fulfilment.delayReasons, r.payments.refunds, r.payments.profit, r.customers.topBySpend, r.customers.complaints]) {
    assert.equal(m.available, false); assert.ok(m.reason.length > 10); assert.equal(m.value, undefined);
  }
});

test('received, completed and cancelled use the selected month; cancelled is never completed', () => {
  const orders = [o({}), o({ status: 'completed' }), o({ status: 'cancelled' }), o({ createdAt: '2026-09-10T10:00:00Z' })];
  const r = buildMonthly({ orders, settings, month: '2026-10', now });
  assert.deepEqual([r.overview.received.value, r.overview.completed.value, r.overview.pending.value, r.overview.cancelled.value], [3, 1, 1, 1]);
  assert.equal(r.overview.received.previous, 1);
  assert.equal(r.overview.received.change.available, false); // previous month has fewer than 3 orders
});

test('month-over-month change needs at least 3 orders in the previous month', () => {
  const prev = [1, 2, 3, 4].map((d) => o({ createdAt: `2026-09-0${d}T10:00:00Z` }));
  const r = buildMonthly({ orders: [...prev, o({}), o({})], settings, month: '2026-10', now });
  assert.equal(r.overview.received.change.available, true);
  assert.equal(r.overview.received.change.value, -50);
});

test('customers are matched by contact, never by name', () => {
  const same = [o({ customerName: 'Priya' }), o({ customerName: 'Priya' })];
  assert.equal(buildMonthly({ orders: same, settings, month: '2026-10', now }).sales.customers.available, false);
  const ids = [o({ customerContact: '+91 98765 43210', createdAt: '2026-09-02T10:00:00Z' }), o({ customerContact: '919876543210x'.slice(0, 5) + '' , createdAt: '2026-10-02T10:00:00Z' })];
  const r = buildMonthly({ orders: [o({ customerContact: '+91 98765-43210', createdAt: '2026-09-02T10:00:00Z' }), o({ customerContact: '+919876543210' })], settings, month: '2026-10', now });
  assert.equal(r.sales.customers.value.returning, 1); assert.equal(ids.length, 2);
});

test('capacity reuses the engine and distinguishes minutes from order counts', () => {
  const r = buildMonthly({ orders: [o({ prepTimeMinutes: 600, deadline: '2026-10-23T12:00:00Z' }), o({ prepTimeMinutes: 30, deadline: '2026-10-23T12:00:00Z' })], settings, month: '2026-10', now });
  assert.equal(r.capacity.days.length, 14);
  const day = r.capacity.days.find((d) => d.dueOrders === 2);
  assert.ok(day && day.dueMinutes === 630);
  assert.ok(r.capacity.sameDayDeadlines.some((d) => d.orders === 2));
  assert.equal(r.capacity.recurringDelays.available, false);
});

test('opportunities come only from supported evidence', () => {
  const empty = buildMonthly({ orders: [], settings, month: '2026-10', now });
  assert.equal(empty.opportunities.length, 0); assert.equal(empty.quality.mode, 'empty');
  const r = buildMonthly({ orders: [o({ item: 'Brownie tray (2)' }), o({ item: 'brownie tray' })], settings, month: '2026-10', now });
  assert.ok(r.opportunities.some((x) => x.id === 'top-product'));
  assert.equal(buildMonthly({ orders: [o({ item: 'A' }), o({ item: 'B' })], settings, month: '2026-10', now }).opportunities.some((x) => x.id === 'top-product'), false);
});

test('payment notes are reported as notes, only when they carry an amount in the month', () => {
  const r = buildMonthly({ orders: [o({ paymentEvidence: [{ kind: 'note', reference: 'x', amount: 500, addedAt: '2026-10-06T10:00:00Z' }, { kind: 'note', reference: 'y', addedAt: '2026-10-06T10:00:00Z' }] })], settings, month: '2026-10', now });
  assert.equal(r.payments.recordedNotes.value.total, 500); assert.equal(r.payments.recordedNotes.value.count, 1);
});
