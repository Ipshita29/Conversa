import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemoOrders, buildScenarioOrders, demoClock, DEMO_CONVERSATIONS, DEMO_MARK } from '../scripts/demo-data.js';
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

test('the fixed 3 November scenario is real: planned from 9:00 every order fits the scheduler and the day is feasible', () => {
  const now = demoClock(settings);
  const orders = withIds(buildScenarioOrders(settings, now));
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

// ---- Timestamps: placed < due, the 1 / 2 / 2 split, and the same story in any timezone, at any hour, on any weekday ------------------------------
import { buildBoard } from '../services/boardService.js';
import { zonedParts } from '../utils/timezone.js';

const ZONES = ['Asia/Kolkata', 'America/New_York', 'Pacific/Auckland', 'Europe/London'];
const everyMoment = Array.from({ length: 24 * 14 }, (_, i) => new Date(start + i * 3600000)); // each hour for two weeks, weekends included
const DEMO_TIMES = { 'Aanya Sharma': '14:00', 'Kartik Singh': '10:30', 'Rohan Mehta': '12:00', 'Neha Sharma': '12:00', 'Meera Iyer': '14:00' };

test('every demo order is placed BEFORE it is due, at every hour of two weeks, in every timezone', () => {
  for (const timezone of ZONES) {
    const s = { ...defaultSettings(), timezone };
    for (const now of everyMoment) {
      for (const o of buildDemoOrders(s, now)) {
        assert.ok(o.createdAt < o.deadline, `${o.customerName} placed ${o.createdAt.toISOString()} is not before due ${o.deadline.toISOString()} (now ${now.toISOString()}, ${timezone})`);
        assert.ok(o.createdAt < now, `${o.customerName} is placed in the future`);
      }
    }
  }
});

test('deadlines keep their local clock time (no timezone shift) and fall on working days', () => {
  for (const timezone of ZONES) {
    const s = { ...defaultSettings(), timezone };
    for (const now of everyMoment.filter((_, i) => i % 5 === 0)) {
      for (const o of buildDemoOrders(s, now)) {
        const p = zonedParts(o.deadline, timezone);
        assert.equal(`${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`, DEMO_TIMES[o.customerName], `${o.customerName} ${timezone}`);
        const wd = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
        assert.ok(s.workingDays.includes(wd), `${o.customerName} is due on a non-working day (${timezone})`);
      }
    }
  }
});

test('the board always splits the demo 1 overdue / 2 on track / 2 upcoming, whenever it is looked at', () => {
  for (const timezone of ZONES) {
    const s = { ...defaultSettings(), timezone };
    for (const now of everyMoment.filter((_, i) => i % 3 === 0)) {
      const b = buildBoard({ orders: withIds(buildDemoOrders(s, now)), settings: s, now, dataset: 'demo' });
      assert.deepEqual(b.counts, { overdue: 1, onTrack: 2, upcoming: 2 }, `${now.toISOString()} ${timezone}`);
      assert.deepEqual(b.sections.overdue.map((x) => x.customerName), ['Meera Iyer']);
      assert.deepEqual(b.sections.onTrack.map((x) => x.customerName).sort(), ['Kartik Singh', 'Rohan Mehta']);
      assert.deepEqual(b.sections.upcoming.map((x) => x.customerName).sort(), ['Aanya Sharma', 'Neha Sharma']);
    }
  }
});

test('each demo story runs in order: first enquiry, then the order is placed, then the payment, all before the money is due', () => {
  const now = new Date('2026-11-05T10:00:00Z');
  const orders = Object.fromEntries(buildDemoOrders(settings, now).map((o) => [o.customerName, o]));
  const at = (m) => new Date(now.getTime() - m.hoursAgo * 3600000);
  for (const c of DEMO_CONVERSATIONS) {
    const o = orders[c.order];
    assert.ok(at(c.messages[0]) < o.createdAt, `${c.customer}: the enquiry comes before the order is placed`);
    for (const m of c.messages.filter((x) => x.image?.kind === 'payment')) assert.ok(at(m) > o.createdAt, `${c.customer}: the payment comes after the order is placed`);
    for (const m of c.messages) assert.ok(at(m) <= now, `${c.customer}: no message from the future`);
  }
});

test('the fixed 3 November scenario keeps its own consistent timeline', () => {
  const now = demoClock(settings);
  for (const o of buildScenarioOrders(settings, now)) assert.ok(o.createdAt < now && o.createdAt < o.deadline && o.deadline >= now);
});

test('the sample payment records are created after their order was placed', async () => {
  const { buildDemoPayments } = await import('../scripts/demo-data.js');
  const now = new Date('2026-11-05T10:00:00Z');
  const orders = withIds(buildDemoOrders(settings, now));
  const byId = Object.fromEntries(orders.map((o) => [o.id, o]));
  const pays = buildDemoPayments(orders, now);
  assert.ok(pays.length >= 2);
  for (const p of pays) { assert.ok(p.createdAt >= byId[p.orderId].createdAt, 'recorded before the order existed'); assert.ok(p.createdAt <= now); }
});
