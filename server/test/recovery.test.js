import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePlan, simulate } from '../services/workloadEngine.js';
import { needsRecovery, situationOf, proposeRevision, buildMessage, customerFirstName, copyText } from '../../client/src/utils/recoveryMessage.js';
import { defaultSettings } from '../config/defaults.js';

const settings = { ...defaultSettings(), timezone: 'Asia/Kolkata' };
const H = 3600000;
const NOW = new Date('2026-10-21T04:30:00Z'); // Wed 21 Oct 2026, 10:00 in Kolkata
let n = 0;
const order = (f = {}) => ({ id: `o${++n}`, customerName: `Cust${n} Sharma`, item: 'Chocolate birthday cake', quantity: 1, status: 'pending', paymentStatus: 'unverified', prepTimeMinutes: 120, deadline: new Date(NOW.getTime() + 48 * H).toISOString(), source: 'manual', ...f });
const plan = (orders) => computePlan({ orders, settings, now: NOW, rangeDays: 7 });
const entryOf = (orders, o) => plan(orders).schedule.find((e) => e.orderId === o.id);
const sim = (orders) => async (payload) => simulate({ orders, changes: payload.changes, settings, now: NOW, rangeDays: 7, probeMinutes: payload.probeMinutes });
const TZ = settings.timezone;

test('a safe order needs no recovery message; overdue and at-risk orders do', () => {
  const safe = order(); const overdue = order({ deadline: new Date(NOW.getTime() - 20 * H).toISOString() });
  const late = order({ prepTimeMinutes: 900, deadline: new Date(NOW.getTime() + 8 * H).toISOString() });
  assert.equal(needsRecovery(safe, entryOf([safe], safe)), false);
  assert.equal(needsRecovery(overdue, entryOf([overdue], overdue)), true);
  assert.equal(needsRecovery(late, entryOf([late], late)), true);
  assert.equal(situationOf(entryOf([overdue], overdue)), 'overdue');
  assert.equal(needsRecovery({ ...overdue, status: 'completed' }, entryOf([overdue], overdue)), false, 'finished orders never get one');
  assert.equal(needsRecovery(safe, undefined), false, 'an order without a schedule entry never gets one');
});

test('overdue order: a revised time is proposed only after the scheduler confirms it, and the saved order is untouched', async () => {
  const o = order({ deadline: new Date(NOW.getTime() - 20 * H).toISOString() });
  const orders = [o, order()];
  const snapshot = JSON.stringify(orders);
  const rev = await proposeRevision({ order: o, entry: entryOf(orders, o), simulate: sim(orders), now: NOW.getTime() });
  assert.equal(rev.kind, 'revised');
  assert.ok(Date.parse(rev.deadline) > NOW.getTime());
  const after = simulate({ orders, changes: [{ type: 'update_order', orderId: o.id, order: { deadline: rev.deadline } }], settings, now: NOW, rangeDays: 7 }).planner.schedule.find((e) => e.orderId === o.id);
  assert.notEqual(after.risk, 'high', 'the proposed time really is feasible');
  assert.equal(JSON.stringify(orders), snapshot);
  const msg = buildMessage({ order: o, entry: entryOf(orders, o), revision: rev, tz: TZ }).text;
  assert.match(msg, /sorry|apolog/i);
  assert.ok(msg.includes('chocolate birthday cake') && msg.includes('Cust'));
});

test('at risk but not late: the message is proactive and does not claim a delay has happened', async () => {
  const o = order({ prepTimeMinutes: 300, deadline: new Date(NOW.getTime() + 7 * H).toISOString() });
  const orders = [o];
  const entry = entryOf(orders, o);
  assert.equal(entry.risk, 'medium'); assert.equal(situationOf(entry), 'tight');
  const rev = await proposeRevision({ order: o, entry, simulate: sim(orders), now: NOW.getTime() });
  assert.equal(rev.kind, 'estimate');
  const text = buildMessage({ order: o, entry, revision: rev, tz: TZ }).text;
  assert.doesNotMatch(text, /sorry|apolog|missed|delay|taking longer|\blate\b/i);
  assert.match(text, /on track|on schedule|in progress/i);
});

test('predicted late (deadline still ahead): proactive wording with the scheduler-confirmed time', async () => {
  const o = order({ prepTimeMinutes: 900, deadline: new Date(NOW.getTime() + 8 * H).toISOString() });
  const orders = [o];
  const entry = entryOf(orders, o);
  assert.equal(situationOf(entry), 'late');
  const rev = await proposeRevision({ order: o, entry, simulate: sim(orders), now: NOW.getTime() });
  assert.equal(rev.kind, 'revised');
  assert.ok(Date.parse(rev.deadline) > Date.parse(entry.scheduledEnd));
  assert.match(buildMessage({ order: o, entry, revision: rev, tz: TZ }).text, /may not be ready|unlikely|longer than planned|more time/i);
});

test('no reliable revised time: nothing is invented and the message asks the customer', async () => {
  const o = order({ prepTimeMinutes: 30000, deadline: new Date(NOW.getTime() - H).toISOString() });
  const orders = [o];
  const entry = entryOf(orders, o);
  const rev = await proposeRevision({ order: o, entry, simulate: sim(orders), now: NOW.getTime() });
  assert.equal(rev.kind, 'none'); assert.ok(rev.reason);
  const text = buildMessage({ order: o, entry, revision: rev, tz: TZ }).text;
  assert.match(text, /what time|new delivery time|a time that suits|alternative|suits you/i);
  assert.doesNotMatch(text.replace(/Wed, Oct 21, 9:00 AM/g, ''), /\d{1,2}:\d{2}/, 'no new time is offered (only the original promise is mentioned)');
  const failing = await proposeRevision({ order: o, entry: { ...entry, kind: 'deadline_passed', scheduledEnd: NOW.toISOString() }, simulate: async () => { throw new Error('down'); }, now: NOW.getTime() });
  assert.equal(failing.kind, 'none');
});

test('missing or odd customer details never break the message', () => {
  const o = order({ customerName: '', item: '', quantity: 3, deadline: new Date(NOW.getTime() - H).toISOString() });
  const entry = entryOf([o], o);
  const text = buildMessage({ order: o, entry, revision: { kind: 'none' }, tz: TZ }).text;
  assert.match(text, /^Hi there|^Hello there/);
  assert.equal(customerFirstName({ customerName: '  <b>Ana</b>\n\u0000 Lee ' }), '<b>Ana</b>'); // text only: React renders it as text, never HTML
  assert.equal(customerFirstName({ customerName: null }), 'there');
});

test('Regenerate cycles through different wordings', () => {
  const o = order({ deadline: new Date(NOW.getTime() - H).toISOString() }); const entry = entryOf([o], o);
  const rev = { kind: 'revised', deadline: new Date(NOW.getTime() + 6 * H).toISOString() };
  const texts = [0, 1, 2].map((variant) => buildMessage({ order: o, entry, revision: rev, tz: TZ, variant }).text);
  assert.equal(new Set(texts).size, 3);
  assert.equal(buildMessage({ order: o, entry, revision: rev, tz: TZ, variant: 3 }).text, texts[0]);
});

test('copy reports success, falls back, and reports failure', async () => {
  let got = null;
  assert.deepEqual(await copyText('hi', { clipboard: { writeText: async (t) => { got = t; } } }), { ok: true }); assert.equal(got, 'hi');
  assert.deepEqual(await copyText('hi', { clipboard: { writeText: async () => { throw new Error('denied'); } }, fallback: () => true }), { ok: true });
  assert.deepEqual(await copyText('hi', { clipboard: { writeText: async () => { throw new Error('denied'); } }, fallback: () => false }), { ok: false });
  assert.deepEqual(await copyText('hi', { clipboard: undefined }), { ok: false });
});
