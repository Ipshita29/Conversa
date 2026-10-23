import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePlan, simulate } from '../services/workloadEngine.js';
import { buildStory, changeKind } from '../../client/src/utils/simulationStory.js';
import { defaultSettings } from '../config/defaults.js';

const settings = { ...defaultSettings(), timezone: 'Asia/Kolkata' };
const H = 3600000;
const NOW = new Date('2026-10-21T04:30:00Z'); // Wed 21 Oct 2026, 10:00 in Kolkata: the single reference time for every scenario below
let n = 0;
const order = (f) => ({ id: `o${++n}`, customerName: `Cust${n}`, item: 'Cake', quantity: 1, status: 'pending', paymentStatus: 'unverified', prepTimeMinutes: 120, deadline: new Date(NOW.getTime() + 3 * 24 * H).toISOString(), ...f });
const run = (orders, change) => {
  const res = simulate({ orders, changes: [change], settings, now: NOW, rangeDays: 14 });
  const byId = Object.fromEntries(orders.map((o) => [o.id, o]));
  const story = buildStory({ change, baseline: res.baseline, after: res.planner, byId, tz: settings.timezone });
  return { res, story };
};
const upd = (id, patch) => ({ type: 'update_order', orderId: id, order: patch });

test('one reference time: the baseline is exactly the current plan at the same moment, and the simulation never mutates the orders', () => {
  const orders = [order({}), order({ prepTimeMinutes: 300 })];
  const snapshot = JSON.stringify(orders);
  const { res } = run(orders, upd(orders[0].id, { prepTimeMinutes: 60 }));
  const current = computePlan({ orders, settings, now: NOW, rangeDays: 14 });
  assert.deepEqual(res.baseline.schedule.map((e) => [e.orderId, e.scheduledEnd, e.risk]), current.schedule.map((e) => [e.orderId, e.scheduledEnd, e.risk]));
  assert.equal(res.baseline.generatedAt, res.planner.generatedAt);
  assert.equal(JSON.stringify(orders), snapshot);
  const sum = (c) => c.high + c.medium;
  assert.equal(sum(res.comparison.currentCounts), res.baseline.schedule.filter((e) => e.risk !== 'low').length);
  assert.equal(sum(res.comparison.simulatedCounts), res.planner.schedule.filter((e) => e.risk !== 'low').length);
});

test('a scenario that changes nothing says so, and names no order as affected', () => {
  const orders = [order({}), order({})];
  const { story } = run(orders, upd(orders[0].id, { prepTimeMinutes: 120 }));
  assert.equal(story.rows.length, 0);
  assert.match(story.headline.title, /No order changes its risk level/);
});

test('deadline moved earlier, still feasible but thin: the explanation names the buffer and the risk count agrees', () => {
  const o = order({ prepTimeMinutes: 120 });
  const finish = NOW.getTime() + 120 * 60000;
  const { story, res } = run([o], upd(o.id, { deadline: new Date(finish + 2 * H).toISOString() }));
  assert.equal(changeKind(upd(o.id, { deadline: 'x' })), 'deadline');
  const t = story.rows[0];
  assert.equal(t.isTarget, true); assert.equal(t.after.risk, 'medium'); assert.equal(t.dir, 'worse');
  assert.match(t.text, /Moving this deadline earlier leaves only 2h of preparation buffer\./);
  assert.deepEqual(story.counts, { before: 0, after: 1 });
  assert.equal(res.comparison.simulatedCounts.medium, 1);
  assert.doesNotMatch(story.headline.text + story.headline.title, /No order changes its risk level/);
  assert.match(story.headline.title, /less margin/);
});

test('deadline moved earlier, infeasible: says why, recommends the scheduler\'s own earliest realistic date, and caps nothing', () => {
  const o = order({ prepTimeMinutes: 360 });
  const { story, res } = run([o], upd(o.id, { deadline: new Date(NOW.getTime() + 2 * H).toISOString() }));
  assert.equal(story.headline.tone, 'high'); assert.match(story.headline.title, /Not possible as requested/);
  const late = res.planner.schedule[0];
  assert.equal(late.shortfallMinutes, 240); // 6h of work in a 2h window: honest, uncapped
  assert.match(story.headline.text, /4h after the deadline/);
  assert.equal(story.headline.alt.deadline, late.suggestedDeadline);
  assert.ok(Date.parse(story.headline.alt.deadline) > Date.parse(late.scheduledEnd));
});

test('deadline moved later: the order behind it improves, and the story says the other order no longer comes first', () => {
  // A (due first) and B (due soon after) each need most of a day, so B ends up late behind A.
  const A = order({ customerName: 'A', prepTimeMinutes: 300, deadline: new Date(NOW.getTime() + 6 * H).toISOString() });
  const B = order({ customerName: 'B', prepTimeMinutes: 300, deadline: new Date(NOW.getTime() + 10 * H).toISOString() });
  const base = computePlan({ orders: [A, B], settings, now: NOW, rangeDays: 14 });
  assert.equal(base.schedule.find((e) => e.orderId === B.id).risk, 'high'); // B is late behind A today
  const { story } = run([A, B], upd(A.id, { deadline: new Date(NOW.getTime() + 5 * 24 * H).toISOString() }));
  const rowB = story.rows.find((r) => r.id === B.id);
  assert.equal(rowB.dir, 'better');
  assert.match(rowB.text, /no longer comes ahead of it/);
  assert.match(story.headline.title, /safer/);
  assert.ok(story.counts.after < story.counts.before);
});

test('preparation time shortened: only the preparation changes, and the finish time moves by exactly that much', () => {
  const o = order({ prepTimeMinutes: 360, deadline: new Date(NOW.getTime() + 4 * H).toISOString() }); // late by 2h today
  const { story, res } = run([o], upd(o.id, { prepTimeMinutes: 180 }));
  assert.equal(changeKind(upd(o.id, { prepTimeMinutes: 1 })), 'prep');
  assert.deepEqual(story.compare.map((c) => c.label), ['Preparation time', 'Predicted finish', 'Buffer before the deadline']);
  assert.equal(story.rows[0].dir, 'better'); assert.equal(story.rows[0].shift, -180);
  assert.match(story.rows[0].text, /3h sooner/);
  assert.equal(res.planner.schedule[0].risk, 'medium'); // 3h sooner, but still only 1h of buffer: honest, not rounded up to "safe"
  assert.match(story.headline.title, /safer/);
  assert.doesNotMatch(story.headline.title + story.headline.text, /No order changes/);
});

test('new rush order that fits: yes, without touching any existing order', () => {
  const existing = [order({}), order({})];
  const { story } = run(existing, { type: 'add_order', order: { customerName: 'Rush', item: 'Cake pops', quantity: 1, source: 'manual', prepTimeMinutes: 60, deadline: new Date(NOW.getTime() + 3 * 24 * H).toISOString() } });
  assert.equal(story.kind, 'rush');
  assert.equal(story.headline.tone, 'low'); assert.match(story.headline.title, /Yes, it fits/);
  assert.equal(story.rows[0].id, 'change_0');
  assert.ok(story.rows.slice(1).every((r) => r.dir === 'same'), 'no existing order gets riskier'); // a few may finish an hour later: listed, but not called a problem
  assert.equal(story.compare[0].original, 'No such order yet');
});

test('new rush order that does not fit: infeasible, with a realistic alternative, and the orders it would hurt are named', () => {
  const A = order({ customerName: 'A', prepTimeMinutes: 300, deadline: new Date(NOW.getTime() + 8 * H).toISOString() });
  const { story } = run([A], { type: 'add_order', order: { customerName: 'Rush', item: 'Big cake', quantity: 1, source: 'manual', prepTimeMinutes: 480, deadline: new Date(NOW.getTime() + 5 * H).toISOString() } });
  assert.equal(story.headline.tone, 'high'); assert.match(story.headline.title, /doesn't fit/);
  assert.ok(story.headline.alt, 'a realistic alternative deadline is offered');
  assert.match(story.headline.alternative, /earliest date the scheduler can actually meet/);
  const rowA = story.rows.find((r) => r.id === A.id);
  assert.equal(rowA.dir, 'worse'); assert.match(rowA.text, /ahead of it in the queue/);
});

test('missing information: the scheduler cannot check it and the story does not pretend otherwise', () => {
  const o = order({ prepTimeMinutes: null });
  const { story } = run([o], upd(o.id, { deadline: new Date(NOW.getTime() + 24 * H).toISOString() }));
  assert.equal(story.headline.tone, 'details'); assert.match(story.headline.text, /preparation time and a deadline/);
});

test('midnight and weekend: a change that pushes work past a day off is reported with the real finish date', () => {
  const friday = new Date('2026-10-23T08:30:00Z'); // Fri 14:00 in Kolkata; Sunday 25 Oct is a day off
  const o = order({ prepTimeMinutes: 480, deadline: new Date('2026-10-24T12:00:00Z').toISOString() }); // 8h: 4h Friday + 4h Saturday
  const res = simulate({ orders: [o], changes: [upd(o.id, { prepTimeMinutes: 720 })], settings, now: friday, rangeDays: 14 }); // 12h: spills to Monday
  const e = res.planner.schedule[0];
  assert.equal(e.kind, 'late');
  assert.equal(e.blocks.at(-1).date, '2026-10-26'); // Monday: Sunday is skipped
  assert.ok(e.shortfallMinutes > 24 * 60, 'honestly more than a day late, because a day off sits in between');
});
