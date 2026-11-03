import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemoOrders, demoClock, DEMO_CONVERSATIONS, DEMO_MARK } from '../scripts/demo-data.js';
import { computePlan, simulate, suggestScenario } from '../services/workloadEngine.js';
import { defaultSettings } from '../config/defaults.js';

const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'demo');
const settings = { ...defaultSettings(), timezone: 'Asia/Kolkata' };
const start = Date.parse('2026-10-19T00:00:00Z'); // a Monday, then 14 days in 2-hour steps: every hour of day, weekends included
const moments = Array.from({ length: 24 * 7 }, (_, i) => new Date(start + i * 2 * 3600000));
const withIds = (orders) => orders.map((o, i) => ({ ...o, id: `d${i}` }));

test('the demo set is exactly five clearly-marked open orders with prices and believable creation times', () => {
  const orders = buildDemoOrders(settings, moments[0]);
  assert.equal(orders.length, 5);
  assert.ok(orders.every((o) => o.notes.startsWith(DEMO_MARK)));
  assert.deepEqual(orders.map((o) => o.customerName), ['Aanya Sharma', 'Kartik Singh', 'Rohan Mehta', 'Neha Sharma', 'Meera Iyer']);
  assert.equal(new Set(orders.map((o) => o.customerName)).size, 5); // no duplicates
  assert.ok(orders.every((o) => ['pending', 'confirmed', 'in_progress'].includes(o.status)));
  assert.deepEqual([...new Set(orders.map((o) => o.source))].sort(), ['instagram', 'whatsapp']);
  assert.ok(orders.every((o) => typeof o.price === 'number' && o.prepTimeMinutes > 0 && o.createdAt < moments[0]));
  assert.ok(orders.some((o) => o.customisation));
});

test('the demo schedule is real: planned from 9:00 on 3 November every order fits the scheduler and the day is feasible', () => {
  const now = demoClock(settings);
  const orders = withIds(buildDemoOrders(settings, now));
  const plan = computePlan({ orders, settings, now, rangeDays: 1 });
  assert.equal(plan.schedule.length, 5); assert.equal(plan.unscheduledOrders.length, 0);
  assert.equal(plan.schedule.filter((e) => e.risk === 'high').length, 0);
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

test('demo conversations: one per demo order, realistic, with pictures, an updated instruction and exactly one unread message', () => {
  const orders = buildDemoOrders(settings, moments[0]);
  assert.equal(DEMO_CONVERSATIONS.length, 5);
  assert.deepEqual(DEMO_CONVERSATIONS.map((c) => c.customer).sort(), orders.map((o) => o.customerName).sort()); // no one else has a conversation
  assert.ok(DEMO_CONVERSATIONS.every((c) => c.order === c.customer && c.messages.length >= 5));
  assert.deepEqual([...new Set(DEMO_CONVERSATIONS.map((c) => c.channel))].sort(), ['instagram', 'whatsapp']);
  const all = DEMO_CONVERSATIONS.flatMap((c) => c.messages);
  assert.deepEqual(DEMO_CONVERSATIONS.filter((c) => c.messages.some((m) => m.unread)).map((c) => c.customer), ['Neha Sharma']);
  assert.ok(DEMO_CONVERSATIONS.every((c) => c.messages.some((m) => m.image?.kind === 'reference'))); // every order has a reference picture
  assert.ok(all.some((m) => m.image?.kind === 'payment') && all.every((m) => !m.image || fs.existsSync(path.join(assets, m.image.file)))); // local assets only
  assert.ok(!all.some((m) => /https?:\/\//.test(m.text ?? '')));
  assert.ok(!all.some((m) => /Tara|Nikhil/.test(m.text ?? '')));
  assert.ok(DEMO_CONVERSATIONS.every((c) => c.messages.every((m, i, a) => i === 0 || m.hoursAgo <= a[i - 1].hoursAgo))); // in time order
});
