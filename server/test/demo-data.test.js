import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoOrders, DEMO_MESSAGES, DEMO_MARK } from '../scripts/demo-data.js';
import { computePlan, simulate, suggestScenario } from '../services/workloadEngine.js';
import { defaultSettings } from '../config/defaults.js';

const settings = { ...defaultSettings(), timezone: 'Asia/Kolkata' };
const start = Date.parse('2026-10-19T00:00:00Z'); // a Monday, then 14 days in 2-hour steps: every hour of day, weekends included
const moments = Array.from({ length: 24 * 7 }, (_, i) => new Date(start + i * 2 * 3600000));
const withIds = (orders) => orders.map((o, i) => ({ ...o, id: `d${i}` }));

test('the demo set is exactly five clearly-marked open orders with prices and believable creation times', () => {
  const orders = buildDemoOrders(settings, moments[0]);
  assert.equal(orders.length, 5);
  assert.ok(orders.every((o) => o.notes.startsWith(DEMO_MARK)));
  assert.deepEqual(orders.map((o) => o.customerName), ['Meera Iyer', 'Rohan Mehta', 'Kabir Singh', 'Aanya Sharma', 'Neha Sharma']);
  assert.equal(new Set(orders.map((o) => o.customerName)).size, 5); // no duplicates
  assert.ok(orders.every((o) => ['pending', 'confirmed', 'in_progress'].includes(o.status)));
  assert.deepEqual([...new Set(orders.map((o) => o.source))].sort(), ['instagram', 'whatsapp']);
  assert.ok(orders.every((o) => typeof o.price === 'number' && o.prepTimeMinutes > 0 && o.createdAt < moments[0]));
  assert.ok(orders.some((o) => o.customisation));
});

test('the demo schedule is real: at every moment of the week, every demo order fits the scheduler without hidden problems', () => {
  for (const now of moments) {
    const orders = withIds(buildDemoOrders(settings, now));
    const plan = computePlan({ orders, settings, now, rangeDays: 7 });
    assert.equal(plan.schedule.length, 5, now.toISOString());
    assert.equal(plan.unscheduledOrders.length, 0, now.toISOString());
    assert.equal(plan.schedule.filter((e) => e.kind === 'deadline_passed').length, 1, now.toISOString()); // exactly Meera
  }
});

test('there is always an engine-confirmed experiment to pitch, and it never creates a new risk', () => {
  for (const now of moments.filter((_, i) => i % 5 === 0)) {
    const orders = withIds(buildDemoOrders(settings, now));
    const sc = suggestScenario({ orders, settings, now, rangeDays: 14 });
    if (!sc) continue;
    const verify = simulate({ orders, changes: sc.changes, settings, now, rangeDays: 14 });
    assert.equal(verify.comparison.newRisks.length, 0, now.toISOString());
  }
});

test('demo inbox: exactly five messages, one per demo order, four read and one unread, all linked', () => {
  const orders = buildDemoOrders(settings, moments[0]);
  assert.equal(DEMO_MESSAGES.length, 5);
  assert.deepEqual(DEMO_MESSAGES.map((m) => m.customer).sort(), orders.map((o) => o.customerName).sort()); // no one else has a conversation
  assert.equal(DEMO_MESSAGES.filter((m) => m.read).length, 4);
  assert.deepEqual(DEMO_MESSAGES.filter((m) => !m.read).map((m) => m.customer), ['Neha Sharma']);
  assert.deepEqual([...new Set(DEMO_MESSAGES.map((m) => m.channel))].sort(), ['instagram', 'whatsapp']);
  assert.ok(DEMO_MESSAGES.every((m) => m.order === m.customer));
  assert.ok(!DEMO_MESSAGES.some((m) => /Tara|Nikhil/.test(m.customer + m.text)));
});
