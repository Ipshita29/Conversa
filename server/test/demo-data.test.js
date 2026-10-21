import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoOrders, DEMO_MESSAGES, DEMO_MARK } from '../scripts/demo-data.js';
import { computePlan, simulate, suggestScenario } from '../services/workloadEngine.js';
import { defaultSettings } from '../config/defaults.js';

const settings = { ...defaultSettings(), timezone: 'Asia/Kolkata' };
const start = Date.parse('2026-10-19T00:00:00Z'); // a Monday, then 14 days in 2-hour steps: every hour of day, weekends included
const moments = Array.from({ length: 24 * 7 }, (_, i) => new Date(start + i * 2 * 3600000));
const withIds = (orders) => orders.map((o, i) => ({ ...o, id: `d${i}` }));

test('the demo set is exactly five clearly-marked orders covering every state', () => {
  const orders = buildDemoOrders(settings, moments[0]);
  assert.equal(orders.length, 5);
  assert.ok(orders.every((o) => o.notes.startsWith(DEMO_MARK)));
  assert.deepEqual(orders.map((o) => o.customerName), ['Aanya Sharma', 'Rohan Mehta', 'Meera Iyer', 'Kabir Singh', 'Tara Bose']);
  assert.deepEqual(orders.map((o) => o.status), ['in_progress', 'confirmed', 'pending', 'pending', 'completed']);
  assert.deepEqual([...new Set(orders.map((o) => o.source))].sort(), ['instagram', 'manual', 'whatsapp']); // every channel
  assert.deepEqual([...new Set(orders.map((o) => o.paymentStatus))].sort(), ['pending', 'unverified', 'verified']); // payment states
  assert.equal(orders.filter((o) => o.prepTimeMinutes === null).length, 1); // exactly one order missing a prep time
  assert.ok(orders.some((o) => o.customisation));
});

test('at every moment of the day and week the story holds: on track, tight, late, needs details, done', () => {
  for (const now of moments) {
    const orders = withIds(buildDemoOrders(settings, now));
    const plan = computePlan({ orders, settings, now, rangeDays: 7 });
    const label = now.toISOString();
    assert.deepEqual(plan.schedule.map((e) => [orders.find((o) => o.id === e.orderId).customerName, e.kind]), [['Aanya Sharma', 'on_track'], ['Rohan Mehta', 'tight'], ['Meera Iyer', 'late']], label);
    const [low, medium, high] = plan.schedule;
    assert.ok(low.bufferMinutes >= settings.riskBufferMinutes, `on-track buffer at ${label}`);
    assert.ok(medium.bufferMinutes > 0 && medium.bufferMinutes < settings.riskBufferMinutes && Math.abs(medium.bufferMinutes - 120) <= 3, `tight buffer ${medium.bufferMinutes} at ${label}`);
    assert.ok(Math.abs(high.shortfallMinutes - 100) <= 3, `late by ${high.shortfallMinutes} at ${label}`);
    assert.ok(high.suggestedDeadline, label);
    assert.deepEqual(plan.unscheduledOrders.map((u) => orders.find((o) => o.id === u.id).customerName), ['Kabir Singh'], label);
    assert.equal(plan.schedule.length + plan.unscheduledOrders.length, 4, label); // the completed order is ignored
    assert.ok(!plan.schedule.some((e) => e.kind === 'deadline_passed'), label);
  }
});

test('the next-moves list reads as a story at every moment: late, tight, blocked, on track', () => {
  for (const now of moments) {
    const orders = withIds(buildDemoOrders(settings, now));
    const moves = computePlan({ orders, settings, now, rangeDays: 7 }).nextMoves;
    assert.deepEqual(moves.map((m) => orders.find((o) => o.id === m.orderId).customerName), ['Meera Iyer', 'Rohan Mehta', 'Kabir Singh', 'Aanya Sharma'], now.toISOString());
    assert.deepEqual(moves.map((m) => m.kind), ['late', 'tight', 'needs_details', 'on_track']);
  }
});

test('there is always an engine-confirmed experiment to pitch, and it never creates a new risk', () => {
  for (const now of moments.filter((_, i) => i % 5 === 0)) {
    const orders = withIds(buildDemoOrders(settings, now));
    const sc = suggestScenario({ orders, settings, now, rangeDays: 14 });
    assert.ok(sc, now.toISOString());
    const verify = simulate({ orders, changes: sc.changes, settings, now, rangeDays: 14 });
    assert.equal(verify.comparison.newRisks.length, 0, now.toISOString());
    assert.ok(verify.comparison.resolvedRisks.length > 0 || sc.kind === 'capacity_check' || (verify.comparison.simulatedNearFreeWindow?.minutes ?? 0) > (verify.comparison.currentNearFreeWindow?.minutes ?? 0), now.toISOString());
  }
});

test('demo inbox: six messages, five read and one unread, spread over both channels and linked to the orders', () => {
  const orders = buildDemoOrders(settings, moments[0]);
  assert.equal(DEMO_MESSAGES.length, 6);
  assert.equal(DEMO_MESSAGES.filter((m) => m.read).length, 5);
  assert.deepEqual(DEMO_MESSAGES.filter((m) => !m.read).map((m) => m.customer), ['Nikhil Rao']);
  assert.deepEqual([...new Set(DEMO_MESSAGES.map((m) => m.channel))].sort(), ['instagram', 'whatsapp']);
  const names = new Set(orders.map((o) => o.customerName));
  assert.ok(DEMO_MESSAGES.filter((m) => m.order).every((m) => names.has(m.order)));
  assert.equal(DEMO_MESSAGES.filter((m) => !m.order).length, 1); // the new rush enquiry has no order yet: it is the one to turn into a draft
});

test('the story survives real orders already in the queue (an overdue one, one ahead of everything, one far later)', () => {
  const dayMs = 86400000;
  for (const now of moments.filter((_, i) => i % 3 === 0)) {
    const others = [
      { customerName: 'Real overdue', item: 'Cake', status: 'pending', paymentStatus: 'unverified', prepTimeMinutes: 180, deadline: new Date(now.getTime() - 30 * 3600000) },
      { customerName: 'Real later', item: 'Cookies', status: 'confirmed', paymentStatus: 'verified', prepTimeMinutes: 60, deadline: new Date(now.getTime() + 20 * dayMs) },
      { customerName: 'Real, no details', item: 'Brownies', status: 'pending', paymentStatus: 'unverified', prepTimeMinutes: null, deadline: null },
    ];
    const demo = buildDemoOrders(settings, now, others); // would throw if the story broke
    const all = [...others.map((o, i) => ({ ...o, id: `x${i}` })), ...demo.map((o, i) => ({ ...o, id: `d${i}` }))];
    const plan = computePlan({ orders: all, settings, now, rangeDays: 7 });
    assert.deepEqual(plan.schedule.filter((e) => e.orderId.startsWith('d')).map((e) => e.kind), ['on_track', 'tight', 'late'], now.toISOString());
    assert.equal(plan.nextMoves.find((m) => m.orderId === 'x0').kind, 'deadline_passed'); // the real overdue order is still honestly reported
    assert.equal(plan.nextMoves[0].orderId, 'x0');
  }
});
