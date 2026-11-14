// Smart replies and the order summary: pure logic, the AI fallback and the channel send calls (with a fake fetch). No database needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderSummary, ruleSuggestions, replyContext, grounded, cleanSuggestions } from '../services/replyLogic.js';
import { summarize } from '../services/paymentLogic.js';
import { suggestFromContext } from '../services/replyService.js';
import * as whatsapp from '../services/integrations/whatsappService.js';
import * as instagram from '../services/integrations/instagramService.js';
import { ApiError } from '../utils/errors.js';

const TZ = 'Asia/Kolkata';
const order = (over = {}) => ({ id: 'ord_2001', customerName: 'Neha Sharma', item: 'Chocolate birthday cake (2 kg)', quantity: 1, price: 2200, customisation: 'Gold topper', status: 'confirmed', paymentStatus: 'unverified', deadline: '2026-11-04T06:30:00.000Z', createdAt: '2026-11-02T08:00:00.000Z', ...over });
const pay = (over) => ({ id: 'p1', kind: 'payment', amount: 1100, method: 'upi', status: 'confirmed', ...over });
const row = (o, payments) => ({ ...summarize(o, payments), method: payments.find((p) => p.status !== 'rejected')?.method ?? null });
const text = (s) => s.summary ?? s;

test('summary uses real figures: total, paid (confirmed only), balance, method and status', () => {
  const o = order(); const r = row(o, [pay({ amount: 1100 })]);
  const s = orderSummary(o, r, { tz: TZ, customerName: 'Neha Sharma' });
  const get = (k) => s.lines.find((l) => l.label === k)?.value;
  assert.equal(get('Order'), '#2001');
  assert.equal(get('Product'), 'Chocolate birthday cake');
  assert.equal(get('Size'), '2 kg');
  assert.equal(get('Total'), '₹2,200');
  assert.equal(get('Paid'), '₹1,100');
  assert.equal(get('Balance'), '₹1,100');
  assert.equal(get('Payment method'), 'UPI');
  assert.equal(get('Payment status'), 'Partly paid');
  assert.equal(get('Customisation'), 'Gold topper');
  assert.match(get('Delivery'), /Wed, 4 Nov/);
  assert.match(s.text, /^Hi Neha, here is a summary/);
});

test('a payment that is only pending verification is NOT counted as paid', () => {
  const o = order(); const r = row(o, [pay({ status: 'pending', amount: 1100 })]);
  const s = orderSummary(o, r, { tz: TZ });
  const get = (k) => s.lines.find((l) => l.label === k)?.value;
  assert.equal(get('Paid'), '₹0');
  assert.equal(get('Awaiting verification'), '₹1,100');
  assert.equal(get('Balance'), '₹2,200');
  assert.equal(get('Payment status'), 'Payment received, being verified');
});

test('fully paid, rejected and COD orders report their true status', () => {
  const o = order();
  const get = (r, k) => orderSummary(o, r, { tz: TZ }).lines.find((l) => l.label === k)?.value;
  assert.equal(get(row(o, [pay({ amount: 2200 })]), 'Payment status'), 'Paid in full');
  assert.equal(get(row(o, [pay({ amount: 2200 })]), 'Balance'), '₹0');
  assert.equal(get(row(o, [pay({ status: 'rejected' })]), 'Payment status'), 'Unpaid');
  assert.equal(get(row(o, [pay({ method: 'cod', status: 'pending', amount: 2200 })]), 'Payment status'), 'Cash on delivery');
  assert.equal(get(row(o, [pay({ method: 'cod', status: 'pending', amount: 2200 })]), 'Payment method'), 'Cash on delivery');
});

test('missing fields are left out, never invented', () => {
  const o = order({ price: null, deadline: null, customisation: null, item: 'Brownies', createdAt: null, quantity: null });
  const s = orderSummary(o, row(o, []), { tz: TZ });
  const labels = s.lines.map((l) => l.label);
  for (const gone of ['Total', 'Balance', 'Delivery', 'Customisation', 'Size', 'Ordered on', 'Quantity', 'Payment method']) assert.ok(!labels.includes(gone), `${gone} should be left out`);
  assert.ok(labels.includes('Product') && labels.includes('Paid') && labels.includes('Payment status'));
  assert.doesNotMatch(s.text, /undefined|null|NaN/);
});

test('what the customer wrote (cake message, icing colour) is taken from the chat spec only', () => {
  const o = order();
  const spec = { fields: [{ key: 'cakeMessage', value: 'Happy Birthday Laddu' }, { key: 'icingColour', value: 'Blue' }, { key: 'flavour', value: null }] };
  const s = orderSummary(o, row(o, []), { tz: TZ, spec });
  assert.equal(s.lines.find((l) => l.label === 'Message on the cake').value, 'Happy Birthday Laddu');
  assert.equal(s.lines.find((l) => l.label === 'Icing colour').value, 'Blue');
  assert.ok(!s.lines.some((l) => l.label === 'Flavour'));
});

const ctxFor = (msg, o = order(), r = null) => replyContext({ customerName: 'Neha Sharma', channel: 'whatsapp', messages: [{ from: 'customer', text: msg }], order: o, row: r ?? row(o, []), tz: TZ });

test('rule suggestions answer from the order record and are 2 or 3 short replies', () => {
  const o = order(); const r = row(o, [pay()]);
  const a = ruleSuggestions(ctxFor('What is the total price?', o, r));
  assert.ok(a.length >= 2 && a.length <= 3);
  assert.ok(a.some((s) => s.text.includes('₹2,200')));
  const b = ruleSuggestions(ctxFor('When will it be ready?', o, r));
  assert.ok(b.some((s) => /Wed, 4 Nov/.test(s.text)));
  const c = ruleSuggestions(ctxFor('I just paid via UPI, screenshot sent', o, row(o, [pay({ status: 'pending' })])));
  assert.ok(c.some((s) => /checked|verify|details/i.test(s.text)) && !c.some((s) => /confirmed/i.test(s.text)));
});

test('without an order or the needed fact, suggestions ask instead of inventing', () => {
  const noOrder = replyContext({ customerName: 'Sam', channel: 'whatsapp', messages: [{ from: 'customer', text: 'How much for a dozen cupcakes and are you free on Friday?' }], order: null, row: null, tz: TZ });
  const a = ruleSuggestions(noOrder);
  assert.ok(a.every((s) => !/₹\d/.test(s.text)), 'no price may be stated');
  assert.ok(a.some((s) => /\?/.test(s.text)));
  const unpriced = order({ price: null, deadline: null });
  const b = ruleSuggestions(ctxFor('How much is it and when is delivery?', unpriced, row(unpriced, [])));
  assert.ok(b.every((s) => !/₹\d/.test(s.text)) && b.every((s) => !/Wed|Thu|Nov/.test(s.text)));
});

test('the grounding guard rejects amounts, dates and times that are not in the context', () => {
  const ctx = ctxFor('hi');
  assert.equal(grounded('The total is ₹2,200.', ctx), true);
  assert.equal(grounded('The total is ₹2,500.', ctx), false);
  assert.equal(grounded('It will be ready on Friday at 5 pm.', ctx), false);
  assert.equal(grounded('It is scheduled for Wed, 4 Nov.', ctx), true);
  assert.deepEqual(cleanSuggestions({ replies: ['Sure, ₹999 it is!', 'Let me check and get back to you.', 'Let me check and get back to you.'] }, ctx).map((s) => s.text), ['Let me check and get back to you.']);
});

test('AI suggestions are used when they stay within the facts; otherwise the rules take over', async () => {
  const ctx = ctxFor('What is the total price?');
  const ok = await suggestFromContext(ctx, { ai: async () => ({ replies: ['The total is ₹2,200.', 'Let me double-check and confirm.'] }) });
  assert.equal(ok.source, 'ai'); assert.equal(ok.suggestions.length, 2);
  const invented = await suggestFromContext(ctx, { ai: async () => ({ replies: ['It will cost ₹3,000 and be ready Friday.'] }) });
  assert.equal(invented.source, 'rules');
  const down = await suggestFromContext(ctx, { ai: async () => { throw new ApiError(503, 'AI_UNAVAILABLE', 'no key'); } });
  assert.equal(down.source, 'rules'); assert.ok(down.suggestions.length >= 2);
  await assert.rejects(suggestFromContext(ctx, { ai: async () => { throw new Error('boom'); } }), /boom/);
});

const fakeFetch = (res) => async () => ({ ok: res.ok, status: res.status ?? (res.ok ? 200 : 400), json: async () => res.body ?? {} });
const cfg = { meta: { whatsapp: { accessToken: 't', phoneNumberId: '123', verifyToken: 'v' }, instagram: { accessToken: 't', verifyToken: 'v' }, graphVersion: 'v21.0' } };

test('channel sends: success returns the message id; a refusal or an outage becomes a clear failure', async () => {
  const ok = await whatsapp.sendText('919811111111', 'Hello', { fetchImpl: fakeFetch({ ok: true, body: { messages: [{ id: 'wamid.1' }] } }) }, cfg);
  assert.deepEqual(ok, { ok: true, externalId: 'wamid.1', to: '+919811111111' });
  const refused = await whatsapp.sendText('919811111111', 'Hello', { fetchImpl: fakeFetch({ ok: false, status: 400, body: { error: { message: 'Re-engagement message' } } }) }, cfg);
  assert.equal(refused.ok, false); assert.match(refused.reason, /Re-engagement/);
  const down = await instagram.sendText('55', 'Hello', { fetchImpl: async () => { throw new Error('offline'); } }, cfg);
  assert.equal(down.ok, false); assert.match(down.reason, /Could not reach Instagram/);
  const unconfigured = await whatsapp.sendText('919811111111', 'Hello', {}, { meta: { whatsapp: { accessToken: '', phoneNumberId: '' } } });
  assert.equal(unconfigured.ok, false); assert.match(unconfigured.reason, /WHATSAPP_ACCESS_TOKEN/);
});

test('payment method quoted follows the money: confirmed first, then a pending non-COD claim, COD last', () => {
  const o = order();
  const r = (payments) => ({ ...row(o, payments), payments });
  const m = (payments) => orderSummary(o, r(payments), { tz: TZ }).lines.find((l) => l.label === 'Payment method')?.value;
  assert.equal(m([pay({ id: 'c', method: 'cod', status: 'pending', amount: 1100 }), pay({ id: 'u', method: 'upi', status: 'pending', amount: 1100 })]), 'UPI');
  assert.equal(m([pay({ id: 'c', method: 'cod', status: 'pending' }), pay({ id: 'b', method: 'bank_transfer', status: 'confirmed' })]), 'Bank transfer');
  assert.equal(m([pay({ method: 'cod', status: 'pending' })]), 'Cash on delivery');
});

test('flavour is not repeated when the customisation already says it', () => {
  const o = order({ customisation: 'Dark chocolate ganache, no nuts' });
  const s = orderSummary(o, row(o, []), { tz: TZ, spec: { fields: [{ key: 'flavour', value: 'Dark chocolate ganache' }] } });
  assert.ok(!s.lines.some((l) => l.label === 'Flavour'));
});

test('WhatsApp sending: numbers are checked as E.164, and each Meta refusal is explained for what it is', async () => {
  const { toE164, explainSend } = whatsapp;
  assert.equal(toE164('+91 98114-11111'), '+919811411111'); assert.equal(toE164('00447911123456'), '+447911123456'); assert.equal(toE164('12345'), null); assert.equal(toE164('abc'), null); assert.equal(toE164('0911111111111'), null);
  const bad = await whatsapp.sendText('12345', 'Hello', { fetchImpl: async () => { throw new Error('must not be called'); } }, cfg); assert.equal(bad.kind, 'invalid_recipient'); // refused before it ever reaches Meta
  const e = (status, error) => explainSend({ status, body: { error } });
  assert.equal(e(400, { code: 131030, message: 'Recipient phone number not in allowed list' }).kind, 'recipient_not_allowed'); assert.match(e(400, { code: 131030 }).reason, /allowed recipient list.*API Setup/s);
  assert.equal(e(401, { code: 190, message: 'expired' }).kind, 'token'); assert.match(e(401, {}).reason, /invalid or expired/);
  assert.equal(e(400, { code: 131047 }).kind, 'window_closed'); assert.equal(e(429, { code: 130429 }).kind, 'rate_limit'); assert.equal(e(400, { code: 100, message: 'Invalid parameter' }).kind, 'invalid');
  assert.equal(e(400, { code: 131026 }).kind, 'undeliverable'); assert.equal(explainSend({ status: 0, error: 'timeout' }).kind, 'network');
  for (const k of [e(400, { code: 131030 }), e(401, {}), e(500, { message: 'x' })]) assert.match(k.reason, /Nothing was sent/);
  const noId = await whatsapp.sendText('919811111111', 'Hello', { fetchImpl: fakeFetch({ ok: true, body: { messages: [] } }) }, cfg); assert.equal(noId.ok, false); // no wamid, no "sent"
  const tpl = await whatsapp.sendTemplate('919811111111', { name: 'hello_world' }, { fetchImpl: fakeFetch({ ok: true, body: { messages: [{ id: 'wamid.T' }] } }) }, cfg); assert.deepEqual([tpl.ok, tpl.externalId], [true, 'wamid.T']);
});
