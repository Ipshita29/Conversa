import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStory, productKey, peopleFor } from '../services/insightsStory.js';

const settings = { timezone: 'Asia/Kolkata' };
const NOW = new Date('2026-11-14T06:00:00Z'); // Saturday 11:30 in Kolkata
const day = (ymd, hm = '12:00') => new Date(`${ymd}T${hm}:00+05:30`).toISOString();
const dates = ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14'];
const prevDates = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'];
const o = (id, ymd, x = {}) => ({ id, customerName: 'Cust ' + id, customerContact: null, item: 'Cake', quantity: 1, price: 1000, status: 'confirmed', createdAt: day(ymd), ...x });
const story = (orders, extra = {}) => buildStory({ orders, settings, dates, prevDates, now: NOW, ...extra });

test('the week runs Monday to Sunday in the business timezone and counts each order on the day it was received', () => {
  const s = story([o(1, '2026-11-09'), o(2, '2026-11-09'), o(3, '2026-11-13'), o(4, '2026-11-09', { createdAt: '2026-11-09T19:00:00Z' })]); // the last is 00:30 on Tuesday in Kolkata
  assert.deepEqual(s.week.days.map((d) => d.weekday), ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
  assert.deepEqual(s.week.days.map((d) => d.orders), [2, 1, 0, 0, 1, 0, 0]);
  assert.equal(s.week.from, '2026-11-09'); assert.equal(s.week.to, '2026-11-15'); assert.equal(s.week.isCurrent, true); assert.equal(s.week.next, null); assert.equal(s.week.prev, '2026-11-02');
  const last = story([o(1, '2026-11-03')], { weekStart: '2026-11-04' }); assert.equal(last.week.from, '2026-11-02'); assert.equal(last.week.total, 1); assert.equal(last.week.next, '2026-11-09');
});

test('drafts and cancelled orders are never counted; money separates booked, collected and outstanding', () => {
  const s = story([o(1, '2026-11-10', { price: 1000 }), o(2, '2026-11-11', { price: 500 }), o(3, '2026-11-11', { status: 'cancelled' }), o(4, '2026-11-11', { status: 'draft' }), o(5, '2026-11-12', { price: undefined })], { collected: { 1: 1000, 2: 200, 5: 50 } });
  assert.equal(s.orders.value, 3); assert.equal(s.money.booked, 1500); assert.equal(s.money.collected, 1200); assert.equal(s.money.outstanding, 300); assert.equal(s.money.unpricedOrders, 1);
  assert.equal(story([o(1, '2026-11-10')], { collected: { 1: 5000 } }).money.collected, 1000, 'collected is never more than the order price');
  assert.equal(story([]).money.available, false);
});

test('comparison with the previous period needs at least 3 orders there', () => {
  const few = story([o(1, '2026-11-10'), o(2, '2026-11-02')]); assert.equal(few.orders.comparison.available, false);
  const ok = story([o(1, '2026-11-10'), o(2, '2026-11-11'), o(3, '2026-11-02'), o(4, '2026-11-03'), o(5, '2026-11-04')]);
  assert.deepEqual([ok.orders.comparison.available, ok.orders.comparison.previous, ok.orders.comparison.change], [true, 3, -33]);
});

test('people: unique contacts, not messages; one person on both channels only when an order links them; never by name', () => {
  const conversations = { a: { channel: 'whatsapp', contactId: '919811111111' }, b: { channel: 'instagram', contactId: 'ig1', orderContact: '+91 98111 11111' }, c: { channel: 'instagram', contactId: 'ig2', orderContact: null }, d: { channel: 'whatsapp', contactId: '919822222222' } };
  const inbound = [['a', '2026-11-10'], ['a', '2026-11-10'], ['a', '2026-11-11'], ['b', '2026-11-12'], ['c', '2026-11-12'], ['d', '2026-11-01']].map(([c, d]) => ({ conversationId: c, at: day(d) }));
  const p = peopleFor({ inbound, conversations }, dates, 'Asia/Kolkata');
  assert.equal(p.value, 2); assert.equal(p.merged, 1); assert.deepEqual(p.byChannel, { whatsapp: 1, instagram: 2 }); // a (WhatsApp) + b (Instagram, same phone) = one person; c = another
});

test('crowd favourite: counted by orders (ties go to units); "4 chocolate pastries" and "Chocolate Pastries" are one product; no data, no card', () => {
  assert.equal(productKey('4 chocolate pastries'), productKey('Chocolate Pastries (box)'));
  const s = story([o(1, '2026-11-10', { item: '4 chocolate pastries', quantity: 4 }), o(2, '2026-11-11', { item: 'Chocolate pastries', quantity: 6 }), o(3, '2026-11-12', { item: 'Pineapple cake' })]);
  assert.deepEqual([s.popular.product, s.popular.orders, s.popular.units, s.popular.repeats], ['Chocolate pastries', 2, 10, true]);
  const tie = story([o(1, '2026-11-10', { item: 'Cupcakes', quantity: 6 }), o(2, '2026-11-11', { item: 'Pineapple cake' })]); assert.equal(tie.popular.product, 'Cupcakes'); assert.equal(tie.popular.tiedOnOrders, 2);
  assert.equal(story([]).popular.available, false);
});

test('busiest weekday: the weekday with most orders received in the period, with the quietest for contrast; needs two orders', () => {
  const s = story([o(1, '2026-11-09'), o(2, '2026-11-09'), o(3, '2026-11-13')]);
  assert.deepEqual([s.busiest.weekday, s.busiest.orders, s.busiest.quietest.orders], ['Monday', 2, 0]);
  assert.equal(story([o(1, '2026-11-09')]).busiest.available, false);
});

test('most regular customer: most orders across all history, by contact (never by similar names); needs more than one order', () => {
  const s = story([o(1, '2026-10-01', { customerName: 'Meera', customerContact: '+91 98111 11111' }), o(2, '2026-11-10', { customerName: 'Meera I.', customerContact: '919811111111' }), o(3, '2026-11-11', { customerName: 'Meera Iyer', customerContact: '919800000000' })]);
  assert.deepEqual([s.regular.available, s.regular.name, s.regular.orders, s.regular.basis], [true, 'Meera I.', 2, 'contact']);
  assert.equal(story([o(1, '2026-11-10'), o(2, '2026-11-11')]).regular.available, false);
});
