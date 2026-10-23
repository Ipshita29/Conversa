import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePlan } from '../services/workloadEngine.js';
import { buildDemoOrders } from '../scripts/demo-data.js';
import { defaultSettings } from '../config/defaults.js';

// Business hours Mon-Sat 09:00-18:00 Asia/Kolkata, 6h of productive preparation per day, 4h "tight" buffer.
const settings = { ...defaultSettings(), timezone: 'Asia/Kolkata' };
const H = 3600000;
const T = (s) => new Date(s);
const NOW = T('2026-10-21T04:30:00Z'); // Wednesday 21 Oct 2026, 10:00 in Kolkata
let n = 0;
const order = (f) => ({ id: `o${++n}`, customerName: `C${n}`, item: 'Cake', quantity: 1, status: 'pending', paymentStatus: 'unverified', prepTimeMinutes: 120, deadline: new Date(NOW.getTime() + 3 * 24 * H), ...f });
const plan = (orders, now = NOW) => computePlan({ orders, settings, now, rangeDays: 14 });
const entry = (p, id) => p.schedule.find((e) => e.orderId === id);

test('on time: a short job with days to spare finishes the same working day, with a comfortable buffer', () => {
  const o = order({ prepTimeMinutes: 120 });
  const e = entry(plan([o]), o.id);
  assert.equal(e.kind, 'on_track'); assert.equal(e.risk, 'low');
  assert.ok(e.bufferMinutes >= settings.riskBufferMinutes);
  assert.equal(Date.parse(e.scheduledStart), NOW.getTime()); // starts now, not days later
  assert.equal(e.blocks.length, 1);
});

test('tight buffer: finishing less than the safety buffer before the deadline is medium risk, not late', () => {
  const finishIfStartedNow = NOW.getTime() + 120 * 60000;
  const o = order({ prepTimeMinutes: 120, deadline: new Date(finishIfStartedNow + 2 * H) });
  const e = entry(plan([o]), o.id);
  assert.equal(e.kind, 'tight'); assert.equal(e.risk, 'medium'); assert.equal(e.bufferMinutes, 120);
});

test('modest delay: an order that cannot be finished in time is late by hours, with a suggested new deadline', () => {
  const o = order({ prepTimeMinutes: 360, deadline: new Date(NOW.getTime() + 4 * H) }); // 6h of work, 4h left
  const e = entry(plan([o]), o.id);
  assert.equal(e.kind, 'late'); assert.equal(e.risk, 'high');
  assert.equal(e.shortfallMinutes, 120);
  assert.ok(Date.parse(e.suggestedDeadline) > Date.parse(e.scheduledEnd));
});

test('past deadline: reported as overdue, but the work is still scheduled from now (never days later without a reason)', () => {
  const o = order({ prepTimeMinutes: 240, deadline: new Date(NOW.getTime() - 5 * H) });
  const p = plan([o]); const e = entry(p, o.id);
  assert.equal(e.kind, 'deadline_passed'); assert.equal(e.risk, 'high');
  assert.equal(Date.parse(e.scheduledStart), NOW.getTime());
  assert.ok(Date.parse(e.scheduledEnd) - NOW.getTime() <= 6 * H, 'an empty queue finishes within the same working day');
  assert.equal(e.precededBy.length, 0);
});

test('missing preparation time or deadline: never given a guessed finish or a risk', () => {
  const noPrep = order({ prepTimeMinutes: null }); const noDeadline = order({ deadline: null }); const neither = order({ prepTimeMinutes: null, deadline: null });
  const p = plan([noPrep, noDeadline, neither]);
  assert.deepEqual(p.unscheduledOrders.map((u) => u.reason).sort(), ['missing_both', 'missing_deadline', 'missing_prep_time']);
  assert.equal(p.schedule.length, 0);
  assert.equal(p.nextMoves.filter((m) => m.kind === 'needs_details').length, 3);
});

test('across midnight and weekends: a long job splits over working days and skips the day off', () => {
  const friday = T('2026-10-23T08:30:00Z'); // Fri 14:00 Kolkata: 4h of capacity left today
  const o = order({ prepTimeMinutes: 600, deadline: T('2026-10-31T10:00:00Z') }); // 10h job
  const p = plan([o], friday); const e = entry(p, o.id);
  assert.deepEqual(e.blocks.map((b) => [b.date, b.minutes]), [['2026-10-23', 240], ['2026-10-24', 360]]); // Fri 4h + Sat 6h
  const ordersAcrossSunday = order({ prepTimeMinutes: 700, deadline: T('2026-10-31T10:00:00Z') });
  const p2 = plan([ordersAcrossSunday], friday);
  assert.ok(!p2.schedule[0].blocks.some((b) => b.date === '2026-10-25'), 'Sunday is a day off'); // 25 Oct 2026 is a Sunday
  assert.equal(p2.schedule[0].blocks.at(-1).date, '2026-10-26');
});

test('preparation never starts before now, and never leaves working hours', () => {
  const orders = Array.from({ length: 8 }, (_, i) => order({ prepTimeMinutes: 60 + 45 * i, deadline: new Date(NOW.getTime() + (i - 2) * 9 * H) }));
  const p = plan(orders);
  for (const e of p.schedule) {
    for (const b of e.blocks) {
      assert.ok(Date.parse(b.start) >= NOW.getTime(), 'block starts at or after now');
      assert.ok(Date.parse(b.end) > Date.parse(b.start));
    }
  }
  for (const d of p.days) assert.ok(d.plannedMinutes <= d.capacityMinutes);
});

test('a backlog of overdue orders pushes a later order back, and says exactly which orders are ahead of it', () => {
  const overdue = [0, 1, 2].map((i) => order({ prepTimeMinutes: 300, deadline: new Date(NOW.getTime() - (10 + i) * H) }));
  const fresh = order({ prepTimeMinutes: 240, deadline: new Date(NOW.getTime() + 2 * 24 * H) });
  const p = plan([fresh, ...overdue]); const e = entry(p, fresh.id);
  assert.deepEqual(e.precededBy.map((x) => x.orderId).sort(), overdue.map((o) => o.id).sort());
  assert.equal(e.precededBy.reduce((s, x) => s + x.minutes, 0), 900);
  assert.equal(e.kind, 'late'); // it really is late, and the plan can show why
  const alone = entry(plan([fresh]), fresh.id);
  assert.equal(alone.kind, 'on_track'); // without the backlog it is comfortably on time
});

test('the demo story decays as the clock moves, so it must be re-anchored: seeded now it is modest, seeded 2 days ago it is a pile-up', () => {
  const seededAt = T('2026-10-21T06:00:00Z');
  const later = T('2026-10-23T09:00:00Z');
  const withIds = (os) => os.map((o, i) => ({ ...o, id: `d${i}` }));
  const stale = computePlan({ orders: withIds(buildDemoOrders(settings, seededAt)), settings, now: later, rangeDays: 14 });
  assert.ok(stale.schedule.filter((e) => e.kind === 'deadline_passed').length >= 2, 'the old anchor leaves overdue orders');
  const fresh = computePlan({ orders: withIds(buildDemoOrders(settings, later)), settings, now: later, rangeDays: 14 });
  assert.deepEqual(fresh.schedule.map((e) => e.kind), ['on_track', 'tight', 'late']);
  const late = fresh.schedule.find((e) => e.kind === 'late');
  assert.ok(late.shortfallMinutes >= 120 && late.shortfallMinutes <= 480, `late by ${late.shortfallMinutes} min`); // 2 to 8 hours
  assert.equal(fresh.unscheduledOrders.length, 1);
});
