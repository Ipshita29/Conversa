// WhatsApp + Instagram, end to end against a throwaway mongod and a fake Meta (no network): signed webhooks, idempotency, delivery receipts, the
// Inbox's real data, conversation -> one order, replies inside Meta's window, OAuth connection with encrypted tokens, and demo / real separation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { createApp } from '../app.js';
import { connectDb } from '../config/db.js';
import { config, validateConfig } from '../config/env.js';
import Order from '../models/Order.js';
import Payment from '../models/Payment.js';
import Message from '../models/Message.js';
import Conversation from '../models/Conversation.js';
import Integration from '../models/Integration.js';
import { reseedDemoOrders, reseedDemoMessages } from '../services/demoSeed.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { redact } from '../utils/log.js';
import { classifyIntent, draftFromConversation, createOrderForConversation } from '../services/orderDraftService.js';
import { resolveConfig, describe, refreshInstagramIfDue } from '../services/integrations/credentials.js';
import { instagramStart, instagramComplete, whatsappComplete, whatsappSignupConfig } from '../services/integrations/oauth.js';
import { clearStatusCache } from '../services/integrations/index.js';
import { parseWebhook as parseWa, parseStatuses as waStatuses } from '../services/integrations/whatsappService.js';
import { parseWebhook as parseIg, parseStatuses as igStatuses } from '../services/integrations/instagramService.js';
import { sendReply } from '../services/replyService.js';

const KEY = 'k'.repeat(48);
const SECRET = 'app-secret-for-tests';

// ---- Pure pieces --------------------------------------------------------------------------------------------------------------------------
test('credentials are encrypted at rest and never readable with the wrong key or after tampering', () => {
  const t = encrypt('EAAB-very-secret-token', KEY);
  assert.ok(!t.includes('EAAB')); assert.equal(decrypt(t, KEY), 'EAAB-very-secret-token');
  assert.equal(decrypt(t, 'x'.repeat(48)), null); assert.equal(decrypt(t.slice(0, -2) + 'AA', KEY), null);
  assert.throws(() => encrypt('x', 'short'), /ENCRYPTION_KEY/);
});

test('logs never contain a token, secret or code', () => {
  const out = redact('GET ?access_token=EAAB123&client_secret=abc&code=AQD99 Authorization: Bearer EAAxyz');
  assert.ok(!/EAAB123|abc|AQD99|EAAxyz/.test(out), out);
});

test('startup validation: demo mode needs nothing; a production server names exactly what it is missing, without values', () => {
  const base = { nodeEnv: 'development', mongoUri: '', clientOrigins: [], serverUrl: '', encryptionKey: '', meta: { appId: '', appSecret: '', whatsapp: { accessToken: '', phoneNumberId: '', verifyToken: '' }, instagram: { accessToken: '', verifyToken: '' } } };
  assert.deepEqual(validateConfig(base).errors, []); // development, no Meta: fine
  const prod = validateConfig({ ...base, nodeEnv: 'production' });
  assert.ok(prod.errors.some((e) => /MONGODB_URI/.test(e)) && prod.errors.some((e) => /CLIENT_URL/.test(e)));
  const half = validateConfig({ ...base, meta: { ...base.meta, appId: '1', whatsapp: { accessToken: 'tok', phoneNumberId: '', verifyToken: '' } } });
  const text = half.warnings.join(' ');
  assert.match(text, /META_APP_SECRET/); assert.match(text, /WHATSAPP_PHONE_NUMBER_ID/); assert.match(text, /ENCRYPTION_KEY/); assert.ok(!/tok/.test(text.replace(/token/gi, '')));
  assert.ok(validateConfig({ ...base, encryptionKey: 'short' }).errors.some((e) => /ENCRYPTION_KEY/.test(e)));
});

test('webhook payloads are parsed: text, pictures, delivery receipts, Instagram DMs and reads; echoes and unknown events are ignored', () => {
  const wa = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
    contacts: [{ wa_id: '919800000001', profile: { name: 'Asha' } }],
    messages: [{ id: 'wamid.1', from: '919800000001', timestamp: '1760000000', type: 'text', text: { body: 'Hi' } }, { id: 'wamid.2', from: '919800000001', timestamp: '1760000010', type: 'image', image: { id: '5551234', caption: 'like this' } },
      { id: 'wamid.3', from: '919800000001', timestamp: '1760000020', type: 'interactive', interactive: { button_reply: { title: 'Yes, confirm' } } }, { id: 'wamid.4', from: '919800000001', type: 'audio', audio: { id: '1' } }],
    statuses: [{ id: 'wamid.out', status: 'delivered', timestamp: '1760000100' }, { id: 'wamid.out', status: 'weird' }] } }] }] };
  const m = parseWa(wa);
  assert.deepEqual(m.map((x) => [x.externalId, x.messageType, x.text, x.mediaId ?? null]), [['wamid.1', 'text', 'Hi', null], ['wamid.2', 'image', 'like this', '5551234'], ['wamid.3', 'interactive', 'Yes, confirm', null], ['wamid.4', 'audio', null, null]]);
  assert.equal(m[0].contactName, 'Asha');
  assert.deepEqual(waStatuses(wa).map((s) => [s.externalId, s.status]), [['wamid.out', 'delivered']]);
  const ig = { object: 'instagram', entry: [{ messaging: [
    { sender: { id: '17841400000001' }, timestamp: 1760000000000, message: { mid: 'm1', text: 'hello' } },
    { sender: { id: '17841400000001' }, timestamp: 1760000001000, message: { mid: 'm2', attachments: [{ type: 'image', payload: { url: 'https://scontent.cdninstagram.com/x.jpg' } }] } },
    { sender: { id: '17841400000009' }, message: { mid: 'm3', text: 'ours', is_echo: true } },
    { sender: { id: '17841400000001' }, timestamp: 1760000002000, read: { mid: 'out-1' } }] }] };
  assert.deepEqual(parseIg(ig).map((x) => [x.externalId, x.messageType, x.mediaUrl ?? null]), [['m1', 'text', null], ['m2', 'image', 'https://scontent.cdninstagram.com/x.jpg']]);
  assert.deepEqual(igStatuses(ig).map((s) => [s.externalId, s.status]), [['out-1', 'read']]);
  assert.deepEqual(parseWa({ object: 'page' }), []); assert.deepEqual(parseIg(null), []);
});

test('intent: a question is an enquiry, buying language with an item is an order, and one word is never enough', () => {
  assert.equal(classifyIntent(['How much is a 2 kg chocolate cake?', 'Do you deliver?'], 'chocolate cake', 'order'), 'enquiry');
  assert.equal(classifyIntent(['Hi, I need 2 chocolate cakes for Saturday, 2 kg each.'], 'chocolate cake', 'order'), 'order');
  assert.equal(classifyIntent(['Hi'], null, 'unclear'), 'unclear');
  assert.equal(classifyIntent(['I want a chocolate cake'], null, 'order'), 'unclear'); // no item read: not an order yet
});

// ---- Against a database ----------------------------------------------------------------------------------------------------------------
const hasMongod = spawnSync('mongod', ['--version']).status === 0;
const skip = hasMongod ? false : 'mongod not installed: integration tests skipped';
let proc; let server; let base; let dir; let proofDir; const saved = {};

before(async () => {
  Object.assign(saved, { enc: config.encryptionKey, secret: config.meta.appSecret, appId: config.meta.appId, wa: { ...config.meta.whatsapp }, ig: { ...config.meta.instagram }, serverUrl: config.serverUrl, clientUrl: config.clientUrl, proof: config.payments.proofDir });
  config.encryptionKey = KEY; config.meta.appSecret = SECRET; config.meta.appId = '1234567890'; config.serverUrl = 'https://api.example.com'; config.clientUrl = 'https://app.example.com';
  Object.assign(config.meta.whatsapp, { verifyToken: 'wa-verify', accessToken: '', phoneNumberId: '', embeddedSignupConfigId: '777' }); Object.assign(config.meta.instagram, { verifyToken: 'ig-verify', accessToken: '' });
  if (!hasMongod) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversa-int-')); proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversa-intproof-'));
  config.payments.proofDir = proofDir;
  const port = 31000 + Math.floor(Math.random() * 900);
  proc = spawn('mongod', ['--dbpath', dir, '--port', String(port), '--bind_ip', '127.0.0.1', '--nounixsocket'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { if (await connectDb(`mongodb://127.0.0.1:${port}/conversa_int_test`)) break; await new Promise((r) => setTimeout(r, 500)); }
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
  await Promise.all([Payment.init(), Message.init(), Conversation.init(), Integration.init()]);
});
after(async () => {
  server?.close(); await mongoose.disconnect(); proc?.kill(); for (const d of [dir, proofDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
  Object.assign(config.meta.whatsapp, saved.wa); Object.assign(config.meta.instagram, saved.ig); Object.assign(config, { encryptionKey: saved.enc, serverUrl: saved.serverUrl, clientUrl: saved.clientUrl }); config.meta.appSecret = saved.secret; config.meta.appId = saved.appId; config.payments.proofDir = saved.proof;
});

const sign = (raw) => `sha256=${crypto.createHmac('sha256', SECRET).update(raw).digest('hex')}`;
const hook = async (channel, payload, { signature } = {}) => { const raw = JSON.stringify(payload); const r = await fetch(`${base}/webhooks/${channel}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature ?? sign(raw) }, body: raw }); return { status: r.status, json: await r.json().catch(() => null) }; };
const api = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
const waMsg = (id, text, from = '919811111111', extra = {}) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { contacts: [{ wa_id: from, profile: { name: 'Priya Nair' } }], messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text }, ...extra }] } }] }] });

test('1. webhook handshake and signatures: the right token answers, a wrong or missing signature is refused and stores nothing', { skip }, async () => {
  const ok = await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wa-verify&hub.challenge=4242`);
  assert.equal(ok.status, 200); assert.equal(await ok.text(), '4242');
  assert.equal((await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`)).status, 403);
  assert.equal((await fetch(`${base}/webhooks/instagram?hub.mode=subscribe&hub.verify_token=ig-verify&hub.challenge=7`)).status, 200);
  const before = await Message.countDocuments();
  assert.equal((await hook('whatsapp', waMsg('wamid.bad', 'hi'), { signature: 'sha256=' + '0'.repeat(64) })).status, 401);
  assert.equal((await hook('whatsapp', waMsg('wamid.none', 'hi'), { signature: '' })).status, 401);
  assert.equal(await Message.countDocuments(), before);
});

test('2. a WhatsApp message appears in the Inbox as a REAL conversation; a duplicate delivery changes nothing', { skip }, async () => {
  const first = await hook('whatsapp', waMsg('wamid.A1', 'Hi, I need 2 chocolate cakes for Saturday, 2 kg each. One should have a Happy Birthday message.'));
  assert.deepEqual([first.status, first.json.stored, first.json.duplicates], [200, 1, 0]);
  const again = await hook('whatsapp', waMsg('wamid.A1', 'Hi, I need 2 chocolate cakes for Saturday, 2 kg each. One should have a Happy Birthday message.'));
  assert.deepEqual([again.status, again.json.stored, again.json.duplicates], [200, 0, 1]); // Meta retries: the same message is never stored twice
  assert.equal(await Message.countDocuments({ externalId: 'wamid.A1' }), 1); assert.equal(await Conversation.countDocuments({ contactId: '919811111111' }), 1);
  const list = (await api('GET', '/conversations?dataset=real')).json.items;
  const c = list.find((x) => x.customerName === 'Priya Nair');
  assert.ok(c); assert.deepEqual([c.channel, c.isDemo, c.unread, c.messages.length], ['whatsapp', false, 1, 1]); assert.ok(c.lastInboundAt);
  assert.equal(c.phone, '919811111111');
});

test('3. an Instagram DM lands in the same Inbox with its own channel; unsupported events are accepted and ignored', { skip }, async () => {
  const ig = { object: 'instagram', entry: [{ messaging: [{ sender: { id: '17841400000042' }, recipient: { id: '17841400000001' }, timestamp: Date.now(), message: { mid: 'ig.mid.1', text: 'Do you do custom cupcakes?' } }] }] };
  assert.deepEqual((await hook('instagram', ig)).json.stored, 1);
  assert.equal((await hook('instagram', ig)).json.stored, 0); // duplicate
  assert.equal((await hook('instagram', { object: 'instagram', entry: [{ changes: [{ field: 'comments', value: {} }] }] })).status, 200); // a comment event: not a message
  assert.equal((await hook('whatsapp', { object: 'page', entry: [] })).status, 200);
  const items = (await api('GET', '/conversations?dataset=real')).json.items;
  assert.deepEqual(items.filter((c) => c.channel === 'instagram').map((c) => [c.isDemo, c.messages.length]), [[false, 1]]);
  assert.deepEqual(items.map((c) => c.channel).sort(), ['instagram', 'whatsapp']);
});

test('4. a customer picture is stored when it can be fetched, and kept (without the picture) when Meta cannot be reached; nothing crashes', { skip }, async () => {
  const r = await hook('whatsapp', waMsg('wamid.IMG1', 'like this', '919811111111', { type: 'image', text: undefined, image: { id: '99887766', caption: 'like this' } }));
  assert.equal(r.json.stored, 1); // no WhatsApp credentials here, so no download: the message is still kept
  const m = await Message.findOne({ externalId: 'wamid.IMG1' }).lean(); assert.equal(m.messageType, 'image'); assert.equal(m.attachment, null); assert.equal(m.text, 'like this');
  assert.equal(m.paymentScan?.state, 'failed'); // honestly reported, so the owner can retry
});

test('5. delivery receipts move an outbound message forward (sent -> delivered -> read) and never backwards', { skip }, async () => {
  const conv = await Conversation.findOne({ contactId: '919811111111' });
  await Message.create({ conversation: conv._id, channel: 'whatsapp', externalId: 'wamid.OUT1', direction: 'outbound', text: 'Yes we can!', receivedAt: new Date(), delivery: { mode: 'real', state: 'sent' } });
  const st = (status, ts) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.OUT1', status, timestamp: String(ts) }] } }] }] });
  const state = async () => (await Message.findOne({ externalId: 'wamid.OUT1' }).lean()).delivery.state;
  assert.equal((await hook('whatsapp', st('delivered', 1760000100))).json.statuses, 1); assert.equal(await state(), 'delivered');
  await hook('whatsapp', st('read', 1760000200)); assert.equal(await state(), 'read');
  await hook('whatsapp', st('delivered', 1760000300)); assert.equal(await state(), 'read'); // a late receipt does not undo "read"
  await hook('whatsapp', st('failed', 1760000400)); assert.equal(await state(), 'read');
  const conv2 = (await api('GET', '/conversations?dataset=real')).json.items.find((c) => c.id === String(conv._id));
  assert.equal(conv2.messages.find((m) => m.text === 'Yes we can!').delivery.state, 'read');
  assert.equal((await hook('whatsapp', st('read', 1760000500).entry[0] && { ...st('read', 1760000500) })).status, 200);
});

const fakeAi = (over = {}) => async () => ({ customerName: 'Priya Nair', item: 'Chocolate cake (2 kg)', quantity: 2, customisation: 'One with a Happy Birthday message', notes: null, price: null, intent: 'order', deadlineDate: null, deadlineTime: null, deadlineIsAmbiguous: false, uncertainties: [], ...over });

test('6. several messages about one order become ONE editable draft; price and deadline are never invented; an enquiry is not an order', { skip }, async () => {
  const conv = await Conversation.findOne({ contactId: '919811111111' });
  await Message.create({ conversation: conv._id, channel: 'whatsapp', externalId: 'wamid.A2', text: 'Make it 2 kg please', receivedAt: new Date(Date.now() + 1000) });
  await Message.create({ conversation: conv._id, channel: 'whatsapp', externalId: 'wamid.A3', text: 'Can you add a gold topper?', receivedAt: new Date(Date.now() + 2000) });
  let prompt = '';
  const d = await draftFromConversation(String(conv._id), { groqJson: async (p) => { prompt = p.user; return fakeAi({ notes: 'gold topper' })(); } });
  assert.match(prompt, /2 chocolate cakes/); assert.match(prompt, /Make it 2 kg/); assert.match(prompt, /gold topper/); // all the messages were read together
  assert.equal(d.intent, 'order'); assert.equal(d.draft.price, undefined); assert.equal(d.draft.deadline, null); // nothing invented
  assert.ok(d.missingFields.includes('deadline')); assert.equal(d.readyToConfirm, false); assert.equal(d.existingOrderId, null);
  const ig = await Conversation.findOne({ contactId: '17841400000042' });
  const e = await draftFromConversation(String(ig._id), { groqJson: fakeAi({ item: 'Cupcakes', quantity: null, intent: 'enquiry' }) });
  assert.equal(e.intent, 'enquiry'); assert.equal(e.readyToConfirm, false);
});

test('7. confirming creates exactly ONE order linked to the conversation: double clicks, retries and parallel requests cannot make a second', { skip }, async () => {
  const conv = await Conversation.findOne({ contactId: '919811111111' });
  const body = { customerName: 'Priya Nair', item: 'Chocolate cake (2 kg)', quantity: 2, customisation: 'Happy Birthday message', prepTimeMinutes: 90, price: 4400, deadline: new Date(Date.now() + 3 * 86400000).toISOString() };
  const results = await Promise.all([1, 2, 3, 4].map(() => api('POST', `/conversations/${conv._id}/orders`, body)));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409]);
  const loser = results.find((r) => r.status === 409); assert.equal(loser.json.error.code, 'ORDER_EXISTS');
  assert.equal(await Order.countDocuments({ customerName: 'Priya Nair' }), 1);
  const order = await Order.findOne({ customerName: 'Priya Nair' }).lean();
  assert.deepEqual([order.source, order.customerContact, order.quantity, order.price], ['whatsapp', '919811111111', 2, 4400]);
  assert.equal(String((await Conversation.findById(conv._id).lean()).orderId), String(order._id)); assert.equal(loser.json.existingOrderId, String(order._id));
  assert.ok(!order.notes?.startsWith('[DEMO]')); // a real order
  // A follow-up instruction or a payment screenshot afterwards never drafts a second order.
  const again = await draftFromConversation(String(conv._id), { groqJson: fakeAi() });
  assert.equal(again.existingOrderId, String(order._id)); assert.equal(again.draft, null);
  assert.equal((await api('GET', `/orders/${order._id}/conversation`)).json.conversation.channel, 'whatsapp'); // open the order from its conversation, and back
});

test('8. a payment screenshot from a real customer is attached to their order; verifying it updates that record only; the owner must verify', { skip }, async () => {
  const conv = await Conversation.findOne({ contactId: '919811111111' }); const order = await Order.findOne({ customerName: 'Priya Nair' });
  const png = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'assets', 'demo', 'pay-aanya-upi.png'));
  const up = await fetch(`${base}/conversations/${conv._id}/attachments`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
  assert.equal(up.status, 201);
  const svc = await import('../services/paymentService.js');
  const p = await svc.createPayment({ orderId: String(order._id), amount: 2200, method: 'upi', transactionId: '991122334455' }, { source: 'chat_screenshot', proofBuffer: png });
  assert.equal(p.status, 'pending'); assert.equal(p.orderId, String(order._id)); // read from an image, never verified by it
  assert.equal((await Order.findById(order._id)).paymentStatus, 'pending');
  const count = await Payment.countDocuments();
  const ok = await api('POST', `/payments/${p.id}/confirm`, { amount: 2200, transactionId: '991122334455', reviewer: 'Owner', acknowledged: true });
  assert.equal(ok.status, 200); assert.equal(await Payment.countDocuments(), count);
  assert.equal((await Order.findById(order._id)).paymentStatus, 'partial'); // 2200 of 4400, confirmed by the owner
});

test('9. replies go through the connected platform inside Meta\'s 24-hour window, and are refused (not lost) outside it; failures are explained', { skip }, async () => {
  const conv = await Conversation.findOne({ contactId: '919811111111' });
  const realFetch = globalThis.fetch; const calls = [];
  Object.assign(config.meta.whatsapp, { accessToken: 'EAAtesttoken', phoneNumberId: '555000111' }); clearStatusCache();
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(base)) return realFetch(url, init); // our own API
    calls.push([String(url), init?.method ?? 'GET']);
    if (String(url).includes('/555000111/messages')) return new Response(JSON.stringify(globalThis.__reject ? { error: { message: 'Re-engagement message' } } : { messages: [{ id: 'wamid.SENT1' }] }), { status: globalThis.__reject ? 400 : 200 });
    return new Response(JSON.stringify({ display_phone_number: '+91 98765 43210', verified_name: 'Sweet Crumbs' }), { status: 200 }); // credential check
  };
  try {
    const sent = await sendReply(String(conv._id), 'Yes, we can make that. The total is ₹4,400.');
    assert.deepEqual([sent.delivery.mode, sent.delivery.state], ['real', 'sent']);
    assert.ok(calls.some(([u, m]) => u.includes('/555000111/messages') && m === 'POST'));
    assert.equal((await Message.findOne({ externalId: 'wamid.SENT1' }).lean()).direction, 'outbound'); // stored under Meta's id, so its receipts can find it
    globalThis.__reject = true;
    await assert.rejects(sendReply(String(conv._id), 'again'), (e) => e.code === 'SEND_FAILED' && /Re-engagement/.test(e.message));
    assert.equal(await Message.countDocuments({ text: 'again' }), 0); // a refused message is not recorded as sent
    delete globalThis.__reject;
    await Message.updateMany({ conversation: conv._id, direction: { $ne: 'outbound' } }, { $set: { receivedAt: new Date(Date.now() - 30 * 3600000) } }); // the customer last wrote 30 hours ago
    await assert.rejects(sendReply(String(conv._id), 'late'), (e) => e.code === 'WINDOW_CLOSED' && /24 hours/.test(e.message));
    assert.equal(calls.filter(([u]) => u.includes('/messages')).length, 2); // the late message never reached Meta
  } finally { globalThis.fetch = realFetch; Object.assign(config.meta.whatsapp, { accessToken: '', phoneNumberId: '' }); clearStatusCache(); }
});

test('10. without Meta credentials the app runs: integrations report "not connected", a reply is a clearly marked simulation, and nothing crashes', { skip }, async () => {
  clearStatusCache();
  const items = (await api('GET', '/integrations')).json;
  assert.deepEqual(items.items.map((i) => [i.channel, i.state]), [['whatsapp', 'not_connected'], ['instagram', 'not_connected']]);
  assert.equal(items.webhooks.whatsapp, 'https://api.example.com/api/webhooks/whatsapp');
  assert.equal((await api('GET', '/health')).json.status, 'ok');
  const conv = await Conversation.findOne({ contactId: '17841400000042' });
  const r = await sendReply(String(conv._id), 'Thanks for asking!');
  assert.deepEqual([r.delivery.mode, r.delivery.state], ['simulated', 'sent']);
  assert.equal(JSON.stringify(items).includes('token'), false);
});

test('11. demo and real data never mix: each page can ask for one data set, and demo records survive a real connection', { skip }, async () => {
  const { created } = await reseedDemoOrders(new Date()); await reseedDemoMessages(created, new Date());
  const names = (r) => r.json.items.map((o) => o.customerName);
  assert.ok(names(await api('GET', '/orders?dataset=real&pageSize=100')).every((n) => n === 'Priya Nair'));
  assert.equal(names(await api('GET', '/orders?dataset=demo&pageSize=100')).length, 5);
  assert.ok((await api('GET', '/conversations?dataset=demo')).json.items.every((c) => c.isDemo)); assert.ok((await api('GET', '/conversations?dataset=real')).json.items.every((c) => !c.isDemo));
  const led = (await api('GET', '/payments?dataset=real')).json; assert.ok(led.rows.every((r) => r.customerName === 'Priya Nair'));
  const plan = (await api('GET', '/planner?dataset=real&days=30')).json; assert.equal(plan.schedule.length, 1);
  assert.equal((await api('GET', '/planner?dataset=demo&days=30')).json.schedule.length, 5);
  assert.equal((await api('GET', '/orders?dataset=bogus')).status, 400);
  assert.equal(await Order.countDocuments({ notes: /^\[DEMO\]/ }), 5); // the five demo orders are untouched by everything above
});

// ---- Connecting accounts (fake Meta) ----------------------------------------------------------------------------------------------------------
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('12. Instagram OAuth: a state is required and single-use, a personal account is refused, the token is stored encrypted and resolved for use', { skip }, async () => {
  const start = await instagramStart(); const state = new URL(start.url).searchParams.get('state');
  const u = new URL(start.url);
  assert.equal(u.origin + u.pathname, 'https://www.instagram.com/oauth/authorize');
  assert.equal(u.searchParams.get('scope'), 'instagram_business_basic,instagram_business_manage_messages'); assert.equal(u.searchParams.get('redirect_uri'), 'https://api.example.com/api/integrations/instagram/oauth/callback');
  const seen = [];
  const meta = (account) => async (url, init) => {
    seen.push(String(url));
    if (String(url).startsWith('https://api.instagram.com/oauth/access_token')) return json({ access_token: 'SHORT', user_id: 17841400000001 });
    if (String(url).includes('ig_exchange_token')) return json({ access_token: 'LONGLIVED-IG-TOKEN', expires_in: 5183944 });
    if (String(url).includes('/me?')) return json({ user_id: '17841400000001', username: 'sweetcrumbs', account_type: account });
    return json({ success: true });
  };
  await assert.rejects(instagramComplete({ code: 'c', state: 'forged' }, { fetchImpl: meta('BUSINESS') }), (e) => e.code === 'INVALID_STATE');
  await assert.rejects(instagramComplete({ code: 'c', state }, { fetchImpl: meta('PERSONAL') }), (e) => e.code === 'NOT_PROFESSIONAL'); // the state was consumed by that attempt
  const s2 = new URL((await instagramStart()).url).searchParams.get('state');
  const r = await instagramComplete({ code: 'c', state: s2 }, { fetchImpl: meta('BUSINESS') });
  assert.equal(r.accountLabel, '@sweetcrumbs');
  await assert.rejects(instagramComplete({ code: 'c', state: s2 }, { fetchImpl: meta('BUSINESS') }), (e) => e.code === 'INVALID_STATE'); // one use only
  const rec = await Integration.findOne({ channel: 'instagram' }).lean();
  assert.equal(rec.status, 'connected'); assert.ok(!JSON.stringify(rec).includes('LONGLIVED')); assert.equal(decrypt(rec.accessTokenEnc, KEY), 'LONGLIVED-IG-TOKEN');
  assert.equal((await resolveConfig()).meta.instagram.accessToken, 'LONGLIVED-IG-TOKEN'); assert.equal((await resolveConfig()).meta.instagram.businessAccountId, '17841400000001');
  assert.ok(seen.some((u) => u.includes('subscribed_apps')));
  assert.equal(JSON.stringify((await api('GET', '/integrations')).json).includes('LONGLIVED'), false); // never returned
});

test('13. token lifecycle: refreshed before it lapses, flagged when Meta refuses, expired when past due, and disconnect forgets it', { skip }, async () => {
  const soon = new Date(Date.now() + 3 * 86400000);
  await Integration.updateOne({ channel: 'instagram' }, { $set: { tokenExpiresAt: soon, tokenIssuedAt: new Date(Date.now() - 50 * 86400000) } });
  assert.equal((await refreshInstagramIfDue({ fetchImpl: async () => json({ access_token: 'REFRESHED', expires_in: 5184000 }) })).refreshed, true);
  let rec = await Integration.findOne({ channel: 'instagram' }).lean();
  assert.equal(decrypt(rec.accessTokenEnc, KEY), 'REFRESHED'); assert.ok(rec.tokenExpiresAt.getTime() - Date.now() > 50 * 86400000);
  assert.equal((await refreshInstagramIfDue({ fetchImpl: async () => assert.fail('not due: no call') })).reason, 'not_due');
  await Integration.updateOne({ channel: 'instagram' }, { $set: { tokenExpiresAt: soon, tokenIssuedAt: new Date(Date.now() - 50 * 86400000) } });
  await refreshInstagramIfDue({ fetchImpl: async () => json({ error: { message: 'Session has expired' } }, 400) });
  rec = await Integration.findOne({ channel: 'instagram' }).lean(); assert.equal(rec.status, 'needs_attention'); assert.match(rec.statusReason, /Connect the account again/);
  await Integration.updateOne({ channel: 'instagram' }, { $set: { status: 'connected', tokenExpiresAt: new Date(Date.now() - 1000) } });
  assert.equal(describe('instagram', await Integration.findOne({ channel: 'instagram' })).status, 'expired');
  assert.equal((await resolveConfig()).meta.instagram.accessToken, ''); // an expired token is never used
  assert.equal((await api('POST', '/integrations/instagram/disconnect')).json.status, 'disconnected');
  rec = await Integration.findOne({ channel: 'instagram' }).lean(); assert.equal(rec.accessTokenEnc, null);
  assert.equal(await Message.countDocuments({ channel: 'instagram' }) > 0, true); // the conversations stay
});

test('14. WhatsApp Embedded Signup: the code is exchanged server-side, the number is checked, the app subscribes to the account and the token is stored encrypted', { skip }, async () => {
  assert.deepEqual([whatsappSignupConfig().ready, whatsappSignupConfig().configId], [true, '777']);
  const urls = [];
  const meta = async (url, init) => {
    urls.push([String(url), init?.method ?? 'GET']);
    if (String(url).includes('/oauth/access_token')) return json({ access_token: 'BUSINESS-TOKEN-XYZ' });
    if (String(url).includes('/subscribed_apps')) return json({ success: true });
    return json({ display_phone_number: '+91 98765 43210', verified_name: 'Sweet Crumbs' });
  };
  await assert.rejects(whatsappComplete({ code: 'c', wabaId: 'abc', phoneNumberId: '1' }, { fetchImpl: meta }), (e) => e.code === 'VALIDATION_ERROR');
  const r = await whatsappComplete({ code: 'AQcode', wabaId: '1029384756', phoneNumberId: '555000222' }, { fetchImpl: meta });
  assert.equal(r.accountLabel, '+91 98765 43210');
  assert.ok(urls.some(([u, m]) => u.includes('/1029384756/subscribed_apps') && m === 'POST'));
  const rec = await Integration.findOne({ channel: 'whatsapp' }).lean();
  assert.deepEqual([rec.status, rec.accountId, rec.businessAccountId], ['connected', '555000222', '1029384756']); assert.equal(decrypt(rec.accessTokenEnc, KEY), 'BUSINESS-TOKEN-XYZ');
  const cfg = await resolveConfig(); assert.deepEqual([cfg.meta.whatsapp.accessToken, cfg.meta.whatsapp.phoneNumberId], ['BUSINESS-TOKEN-XYZ', '555000222']);
  await assert.rejects(whatsappComplete({ code: 'x', wabaId: '1029384756', phoneNumberId: '555000222' }, { fetchImpl: async () => json({ error: { message: 'Invalid code' } }, 400) }), (e) => e.code === 'META_REJECTED');
});

// ---- Conversation -> order draft, automatically ---------------------------------------------------------------------------------------------
import { autoDraftForConversation, scheduleAutoDraft } from '../services/autoDraftService.js';
import { replyContext, ruleSuggestions } from '../services/replyLogic.js';

const ymdTomorrow = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 86400000));
// A stand-in for the AI that reads the PROMPT it is given, so each run sees exactly the messages that existed at that moment.
const reader = (rules) => async (p) => {
  const said = p.user; const out = { customerName: 'Meera Pillai', item: null, quantity: null, customisation: null, notes: null, price: null, intent: 'unclear', deadlineDate: null, deadlineTime: null, deadlineIsAmbiguous: false, uncertainties: [] };
  for (const [re, patch] of rules) if (re.test(said)) Object.assign(out, patch);
  return out;
};
const chocolate = reader([
  [/order a chocolate cake/i, { item: 'Chocolate cake', quantity: 1, intent: 'order' }],
  [/2 kg/i, { item: 'Chocolate cake (2 kg)' }], [/tomorrow at 5 PM/i, { deadlineDate: ymdTomorrow(), deadlineTime: '17:00' }],
  [/Happy Birthday Aanya/i, { customisation: 'Happy Birthday Aanya' }], [/Actually make it 3 kg/i, { item: 'Chocolate cake (3 kg)' }],
]);
const text = (id, body, from = '919822222222') => waMsg(id, body, from).entry[0].changes[0].value.contacts[0].profile.name && { ...waMsg(id, body, from), entry: [{ changes: [{ field: 'messages', value: { contacts: [{ wa_id: from, profile: { name: 'Meera Pillai' } }], messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }] } }] }] };

test('15. three WhatsApp messages become ONE order draft in Orders, linked to the conversation, with the customer\'s own details and the gaps marked', { skip }, async () => {
  const M = ['Hi, I want to order a chocolate cake.', '2 kg, for tomorrow at 5 PM.', 'Please write Happy Birthday Aanya on it.'];
  const steps = [];
  for (let i = 0; i < M.length; i++) {
    const r = await hook('whatsapp', text(`wamid.D${i}`, M[i]));
    assert.deepEqual([r.json.stored, r.json.duplicates], [1, 0]);
    const conv = await Conversation.findOne({ contactId: '919822222222' });
    steps.push(await autoDraftForConversation(String(conv._id), { groqJson: chocolate })); // what the scheduled run does after each message
  }
  assert.deepEqual(steps.map((s) => s.action), ['created', 'updated', 'updated']);
  assert.equal(await Conversation.countDocuments({ contactId: '919822222222' }), 1); // one conversation, three messages
  assert.equal(await Message.countDocuments({ externalId: /^wamid\.D/ }), 3);
  assert.equal(await Order.countDocuments({ customerName: 'Meera Pillai' }), 1); // ONE order
  const o = await Order.findOne({ customerName: 'Meera Pillai' }).lean(); const conv = await Conversation.findOne({ contactId: '919822222222' }).lean();
  assert.deepEqual([o.status, o.source, o.customerContact, o.item, o.customisation], ['draft', 'whatsapp', '919822222222', 'Chocolate cake (2 kg)', 'Happy Birthday Aanya']);
  assert.equal(new Date(o.deadline).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }), '17:00'); // the requested time, in the business timezone
  assert.equal(o.price ?? null, null); // never invented
  assert.equal(String(conv.orderId), String(o._id)); assert.ok(o.draft.auto); assert.deepEqual(o.draft.messageIds.length, 3);
  assert.ok(steps[0].orderId === steps[2].orderId); // the same draft, updated
  // It appears in Orders (as a draft) but is not scheduled, counted or reported until the owner confirms it.
  assert.equal((await api('GET', '/orders?dataset=real&pageSize=100')).json.items.find((x) => x.id === String(o._id)).status, 'draft');
  assert.ok(!(await api('GET', '/planner?dataset=real&days=30')).json.schedule.some((e) => e.orderId === String(o._id)));
  assert.ok(!JSON.stringify((await api('GET', '/dashboard')).json).includes('Meera Pillai'));
});

test('16. a duplicate webhook delivery creates no message, no draft run and no second order', { skip }, async () => {
  const before = { m: await Message.countDocuments(), o: await Order.countDocuments() };
  const r = await hook('whatsapp', text('wamid.D1', '2 kg, for tomorrow at 5 PM.'));
  assert.deepEqual([r.json.stored, r.json.duplicates], [0, 1]);
  assert.deepEqual([await Message.countDocuments(), await Order.countDocuments()], [before.m, before.o]);
  const { ingest } = await import('../services/messageService.js');
  const again = await ingest([{ channel: 'whatsapp', externalId: 'wamid.D1', contactId: '919822222222', contactName: 'Meera Pillai', messageType: 'text', text: 'x', receivedAt: new Date() }]);
  assert.deepEqual(again.toRead, []); // nothing new arrived, so nothing is queued for reading
});

test('17. a correction updates the SAME draft; the owner\'s edits are never overwritten; a confirmed order is never touched', { skip }, async () => {
  const conv = await Conversation.findOne({ contactId: '919822222222' }); const id = String(conv._id);
  const draft = () => Order.findOne({ customerName: 'Meera Pillai' }).lean();
  const first = await draft();
  await hook('whatsapp', text('wamid.D3', 'Actually make it 3 kg please.'));
  const r = await autoDraftForConversation(id, { groqJson: chocolate });
  assert.equal(r.action, 'updated'); assert.deepEqual(r.fields, ['item']);
  const second = await draft(); assert.equal(String(second._id), String(first._id)); assert.equal(second.item, 'Chocolate cake (3 kg)'); assert.equal(await Order.countDocuments({ customerName: 'Meera Pillai' }), 1);
  assert.equal(second.customisation, 'Happy Birthday Aanya'); // what the customer said earlier is kept
  // The owner fixes the customisation by hand: later automatic runs fill blanks only.
  await new Promise((r2) => setTimeout(r2, 20));
  assert.equal((await api('PATCH', `/orders/${first._id}`, { customisation: 'Happy Birthday Aanya (gold lettering)', notes: null })).status, 200);
  const ownerFix = reader([[/./, { item: 'Chocolate cake (5 kg)', quantity: 1, customisation: 'something else', notes: 'Delivery to Flat 4', intent: 'order' }]]);
  const r2 = await autoDraftForConversation(id, { groqJson: ownerFix });
  const third = await draft();
  assert.equal(third.customisation, 'Happy Birthday Aanya (gold lettering)'); assert.equal(third.item, 'Chocolate cake (3 kg)'); // untouched
  assert.equal(third.notes, 'Delivery to Flat 4'); assert.ok(r2.fields.includes('notes')); assert.equal(third.draft.ownerEdited, true); // only the blank was filled
  // Confirmed: automatic reading stops.
  assert.equal((await api('PATCH', `/orders/${first._id}`, { status: 'confirmed' })).status, 200);
  assert.deepEqual(await autoDraftForConversation(id, { groqJson: ownerFix }), { action: 'skipped', reason: 'order_confirmed', orderId: String(first._id) });
  assert.equal((await draft()).item, 'Chocolate cake (3 kg)');
});

test('18. an enquiry creates no draft; a confirmed draft joins the scheduler; Instagram conversations are read the same way', { skip }, async () => {
  const enquiry = reader([[/./, { item: 'Chocolate cake', quantity: 1, intent: 'enquiry' }]]);
  await hook('whatsapp', text('wamid.E1', 'How much is a 2 kg chocolate cake? Do you deliver?', '919833333333'));
  const c = await Conversation.findOne({ contactId: '919833333333' });
  assert.deepEqual(await autoDraftForConversation(String(c._id), { groqJson: enquiry }), { action: 'skipped', reason: 'not_an_order', intent: 'enquiry' });
  assert.equal(await Order.countDocuments({ source: 'whatsapp', customerContact: '919833333333' }), 0);
  // Instagram: same pipeline, its own channel.
  const ig = { object: 'instagram', entry: [{ messaging: [{ sender: { id: '17841400000077' }, timestamp: Date.now(), message: { mid: 'ig.D1', text: 'Hi, I want to order a chocolate cake. 2 kg, for tomorrow at 5 PM. Please write Happy Birthday Aanya on it.' } }] }] };
  assert.equal((await hook('instagram', ig)).json.stored, 1);
  const igc = await Conversation.findOne({ contactId: '17841400000077' });
  assert.equal((await autoDraftForConversation(String(igc._id), { groqJson: chocolate })).action, 'created');
  const igo = await Order.findOne({ customerContact: '17841400000077' }).lean();
  assert.deepEqual([igo.source, igo.status, igo.item, igo.customisation], ['instagram', 'draft', 'Chocolate cake (2 kg)', 'Happy Birthday Aanya']);
  // Confirming makes it a real order the scheduler plans.
  const before = (await api('GET', '/planner?dataset=real&days=30')).json.schedule.length;
  assert.equal((await api('PATCH', `/orders/${igo._id}`, { status: 'confirmed', prepTimeMinutes: 90 })).status, 200);
  const plan = (await api('GET', '/planner?dataset=real&days=30')).json;
  assert.equal(plan.schedule.length, before + 1); assert.ok(plan.schedule.some((e) => e.orderId === String(igo._id)));
});

test('19. the suggested reply asks the customer for exactly what a draft still lacks', () => {
  const order = { id: 'o1', customerName: 'Meera', item: 'Chocolate cake', quantity: 1, status: 'draft', price: null, deadline: null, createdAt: new Date().toISOString(), draft: { missingFields: ['deadline', 'prepTimeMinutes'] } };
  const ctx = replyContext({ customerName: 'Meera Pillai', channel: 'whatsapp', messages: [{ from: 'customer', text: 'Hi, I want to order a chocolate cake.' }], order, row: null, tz: 'Asia/Kolkata' });
  assert.deepEqual(ctx.order.missing, ['deadline']); // the preparation time is the owner's, never asked of the customer
  assert.match(ruleSuggestions(ctx)[0].text, /could you tell me the date and time you need it by\?/);
});

test('20. reading is scheduled after a pause, once per conversation, and again if more messages arrive while it runs', async () => {
  const saved = { ...config.autoDraft }; config.autoDraft = { enabled: true, delayMs: 20 };
  try {
    const calls = []; let release;
    const run = (id) => { calls.push(id); return new Promise((r) => { release = r; }); };
    scheduleAutoDraft('c1', { delayMs: 20, run }); scheduleAutoDraft('c1', { delayMs: 20, run }); scheduleAutoDraft('c1', { delayMs: 20, run }); // three quick messages
    await new Promise((r) => setTimeout(r, 80)); assert.equal(calls.length, 1); // read once, together
    scheduleAutoDraft('c1', { delayMs: 20, run }); await new Promise((r) => setTimeout(r, 60)); assert.equal(calls.length, 1); // arrived mid-run: waits
    release(); await new Promise((r) => setTimeout(r, 120)); assert.equal(calls.length, 2); release?.(); // then read again
    config.autoDraft = { enabled: false, delayMs: 20 }; scheduleAutoDraft('c2', { delayMs: 5, run }); await new Promise((r) => setTimeout(r, 40)); assert.equal(calls.includes('c2'), false); // switched off
  } finally { config.autoDraft = saved; }
});

// ---- Instagram with Unified Login (Facebook Login for Business + configuration id), against a fake Meta -----------------------------------------
import * as igSvc from '../services/integrations/instagramService.js';
const unifiedOn = () => { const was = { ...config.meta.instagram }; Object.assign(config.meta.instagram, { mode: 'unified', loginConfigId: '1679980733491845', accessToken: '', businessAccountId: '' }); return () => Object.assign(config.meta.instagram, was); };
const fakeMeta = (o = {}) => {
  const seen = [];
  const fn = async (url, init) => {
    const u = String(url); seen.push([init?.method ?? 'GET', u.replace(/access_token=[^&]+/, 'access_token=…').replace(/client_secret=[^&]+/, 'client_secret=…')]);
    if (u.includes('/oauth/access_token')) return o.exchange ?? json({ access_token: 'SUAT-TOKEN-ABC' });
    if (u.includes('/debug_token')) return json({ data: { is_valid: true, expires_at: 0, scopes: ['instagram_basic', 'instagram_manage_messages'], ...(o.debug ?? {}) } });
    if (u.includes('/me/assigned_instagram_accounts')) return json({ data: o.accounts ?? [{ id: '17841400000001', username: 'sweetcrumbs', name: 'Sweet Crumbs' }] });
    if (u.includes('/subscribed_apps')) return json(o.subscribe ?? { success: true });
    return json({ id: '17841400000001', username: 'sweetcrumbs' });
  };
  return { fn, seen };
};

test('21. Unified Login: the authorization URL uses the configuration id (no scope) and the server-side redirect; missing settings are named', { skip }, async () => {
  const off = unifiedOn();
  try {
    const u = new URL((await instagramStart()).url);
    assert.equal(u.origin + u.pathname, `https://www.facebook.com/${config.meta.graphVersion}/dialog/oauth`);
    assert.deepEqual([u.searchParams.get('config_id'), u.searchParams.get('client_id'), u.searchParams.get('response_type'), u.searchParams.get('override_default_response_type'), u.searchParams.has('scope')], ['1679980733491845', '1234567890', 'code', 'true', false]);
    assert.equal(u.searchParams.get('redirect_uri'), 'https://api.example.com/api/integrations/instagram/oauth/callback'); assert.ok(u.searchParams.get('state').length > 20);
    config.meta.instagram.loginConfigId = ''; config.meta.instagram.mode = 'unified';
    await assert.rejects(instagramStart(), (e) => e.code === 'INTEGRATION_UNAVAILABLE' && /INSTAGRAM_LOGIN_CONFIG_ID/.test(e.message) && !/1234567890/.test(e.message));
  } finally { off(); }
});

test('22. Unified Login callback: state checked, code exchanged on graph.facebook.com, account found, token encrypted, webhooks subscribed; failures are explained and store nothing', { skip }, async () => {
  const off = unifiedOn(); await Integration.deleteOne({ channel: 'instagram' });
  try {
    const state = async () => new URL((await instagramStart()).url).searchParams.get('state');
    await assert.rejects(instagramComplete({ code: 'c', state: 'forged' }, { fetchImpl: fakeMeta().fn }), (e) => e.code === 'INVALID_STATE');
    const bad = fakeMeta({ exchange: json({ error: { message: 'Invalid verification code format.' } }, 400) });
    await assert.rejects(instagramComplete({ code: 'c', state: await state() }, { fetchImpl: bad.fn }), (e) => e.code === 'META_REJECTED' && /Invalid verification code/.test(e.message));
    await assert.rejects(instagramComplete({ code: 'c', state: await state() }, { fetchImpl: fakeMeta({ debug: { scopes: ['instagram_basic'] } }).fn }), (e) => e.code === 'MISSING_PERMISSION');
    await assert.rejects(instagramComplete({ code: 'c', state: await state() }, { fetchImpl: fakeMeta({ accounts: [] }).fn }), (e) => e.code === 'NO_ACCOUNT');
    assert.equal((await Integration.findOne({ channel: 'instagram' }))?.accessTokenEnc ?? null, null); // nothing stored by any failure

    const meta = fakeMeta();
    const r = await instagramComplete({ code: 'c', state: await state() }, { fetchImpl: meta.fn });
    assert.deepEqual([r.accountLabel, r.subscribed], ['@sweetcrumbs', true]);
    assert.ok(meta.seen.every(([, u]) => u.startsWith('https://graph.facebook.com/'))); // never the Instagram-Login host
    assert.ok(meta.seen.some(([m, u]) => m === 'POST' && u.includes('/17841400000001/subscribed_apps') && u.includes('subscribed_fields=messages')));
    const rec = await Integration.findOne({ channel: 'instagram' }).lean();
    assert.deepEqual([rec.status, rec.apiMode, rec.accountId, rec.tokenExpiresAt], ['connected', 'unified', '17841400000001', null]); // a system-user token that never expires
    assert.equal(decrypt(rec.accessTokenEnc, KEY), 'SUAT-TOKEN-ABC'); assert.ok(!JSON.stringify(rec).includes('SUAT-TOKEN'));
    const cfg = await resolveConfig();
    assert.deepEqual([cfg.meta.instagram.mode, cfg.meta.instagram.businessAccountId, cfg.meta.instagram.accessToken], ['unified', '17841400000001', 'SUAT-TOKEN-ABC']);
    assert.equal(JSON.stringify((await api('GET', '/integrations')).json).includes('SUAT'), false);
  } finally { off(); }
});

test('23. Unified Login messaging: statuses and replies use graph.facebook.com with the account id; Meta errors are reported honestly', { skip }, async () => {
  const off = unifiedOn();
  try {
    const cfg = await resolveConfig(); const calls = [];
    const f = (res) => async (url, init) => { calls.push([init?.method ?? 'GET', String(url)]); return res; };
    const st = await igSvc.checkStatus({ fetchImpl: f(json({ id: '17841400000001', username: 'sweetcrumbs' })) }, cfg);
    assert.deepEqual([st.status, st.accountLabel], ['connected', '@sweetcrumbs']); assert.equal(calls[0][1].startsWith(`https://graph.facebook.com/${config.meta.graphVersion}/17841400000001?`), true);
    const ok = await igSvc.sendText('99001122', 'Hello!', { fetchImpl: f(json({ recipient_id: '99001122', message_id: 'mid.OUT1' })) }, cfg);
    assert.deepEqual(ok, { ok: true, externalId: 'mid.OUT1' }); assert.deepEqual(calls.at(-1), ['POST', `https://graph.facebook.com/${config.meta.graphVersion}/17841400000001/messages`]);
    const expired = await igSvc.sendText('1', 'x', { fetchImpl: f(json({ error: { code: 190, message: 'Error validating access token' } }, 401)) }, cfg);
    assert.deepEqual([expired.ok, expired.code], [false, 190]); assert.match(expired.reason, /expired or was revoked/);
    const closed = await igSvc.sendText('1', 'x', { fetchImpl: f(json({ error: { code: 10, error_subcode: 2534022, message: 'outside window' } }, 400)) }, cfg);
    assert.deepEqual([closed.ok, closed.code], [false, 'WINDOW_CLOSED']); assert.match(closed.reason, /24 hours/);
    assert.match((await igSvc.sendText('1', 'x', { fetchImpl: f(json({ error: { code: 200, message: 'no permission' } }, 403)) }, cfg)).reason, /permission/);
    assert.match((await igSvc.sendText('1', 'x', { fetchImpl: f(json({ error: { code: 551, message: 'unavailable' } }, 400)) }, cfg)).reason, /can no longer be messaged/);
    assert.equal((await igSvc.sendText('1', 'x', { fetchImpl: async () => { throw new Error('offline'); } }, cfg)).ok, false);
  } finally { off(); }
});

test('24. a dead Instagram token is surfaced: the reply is refused with the reason, Settings shows Needs attention, and nothing is recorded as sent', { skip }, async () => {
  const off = unifiedOn(); const realFetch = globalThis.fetch; clearStatusCache();
  const conv = await Conversation.findOne({ contactId: '17841400000042' });
  await Message.updateOne({ conversation: conv._id, direction: { $ne: 'outbound' } }, { $set: { receivedAt: new Date() } }); // inside the 24-hour window
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(base)) return realFetch(url, init);
    if (String(url).includes('/messages')) return json({ error: { code: 190, message: 'Error validating access token' } }, 401);
    return json({ id: '17841400000001', username: 'sweetcrumbs' }); // the credential check before sending still passes
  };
  try {
    await assert.rejects(sendReply(String(conv._id), 'Thanks!'), (e) => e.code === 'SEND_FAILED' && /expired or was revoked/.test(e.message));
    assert.equal(await Message.countDocuments({ conversation: conv._id, text: 'Thanks!' }), 0);
    assert.equal((await Integration.findOne({ channel: 'instagram' }).lean()).status, 'needs_attention');
    clearStatusCache(); globalThis.fetch = async (url, init) => (String(url).startsWith(base) ? realFetch(url, init) : json({ error: { code: 190, message: 'Error validating access token' } }, 401));
    const card = (await api('GET', '/integrations')).json.items.find((i) => i.channel === 'instagram');
    assert.equal(card.state, 'needs_attention'); assert.match(card.statusReason, /expired or was revoked|Connect the account again/);
  } finally { globalThis.fetch = realFetch; off(); clearStatusCache(); }
});

test('25. Unified Login webhooks: events wrapped in changes[] are read like messaging[]; echoes, reactions and unknown fields are ignored', { skip }, async () => {
  const msg = (mid, text, extra = {}) => ({ sender: { id: '17841400000555' }, recipient: { id: '17841400000001' }, timestamp: Date.now(), message: { mid, text, ...extra } });
  const wrapped = { object: 'instagram', entry: [{ id: '17841400000001', time: Date.now(), changes: [
    { field: 'messages', value: msg('ig.U1', 'Hi! I want to order a chocolate cake.') },
    { field: 'messages', value: { ...msg('ig.U2', 'ours'), message: { mid: 'ig.U2', text: 'ours', is_echo: true } } },
    { field: 'messages', value: msg('ig.U3', undefined, { attachments: [{ type: 'image', payload: { url: 'https://scontent.cdninstagram.com/ref.jpg' } }] }) },
    { field: 'comments', value: { id: 'c1' } }] }] };
  assert.deepEqual(parseIg(wrapped).map((m) => [m.externalId, m.messageType]), [['ig.U1', 'text'], ['ig.U3', 'image']]);
  assert.deepEqual(igStatuses({ object: 'instagram', entry: [{ changes: [{ field: 'messaging_seen', value: { sender: { id: '1' }, timestamp: 1760000000000, read: { mid: 'out-9' } } }] }] }).map((s) => [s.externalId, s.status]), [['out-9', 'read']]);
  const r = await hook('instagram', wrapped); assert.equal(r.json.stored, 2);
  assert.equal((await hook('instagram', wrapped)).json.stored, 0); // a retry
  const c = await Conversation.findOne({ channel: 'instagram', contactId: '17841400000555' }); assert.deepEqual([c.isDemo, await Message.countDocuments({ conversation: c._id })], [false, 2]);
  const img = await Message.findOne({ externalId: 'ig.U3' }).lean(); assert.equal(img.messageType, 'image'); assert.equal(img.attachment, null); // no token here, so the picture could not be fetched: kept honestly without it
  assert.equal((await hook('instagram', { object: 'instagram', entry: [{ changes: [{ field: 'message_reactions', value: {} }] }] })).status, 200); // unknown event: accepted, ignored, logged by field name only
  assert.equal((await hook('instagram', wrapped, { signature: 'sha256=' + '1'.repeat(64) })).status, 401);
});

test('26. Instagram DMs become drafts exactly like WhatsApp: multiple messages, one draft, linked, source Instagram, unconfirmed, unscheduled, and an enquiry makes none', { skip }, async () => {
  const c = await Conversation.findOne({ channel: 'instagram', contactId: '17841400000555' });
  const hi = (id, text) => hook('instagram', { object: 'instagram', entry: [{ changes: [{ field: 'messages', value: { sender: { id: '17841400000555' }, recipient: { id: '17841400000001' }, timestamp: Date.now(), message: { mid: id, text } } }] }] });
  await hi('ig.U4', '2 kg, for tomorrow at 5 PM.'); await hi('ig.U5', 'Please write Happy Birthday Aanya on it.');
  const run = () => autoDraftForConversation(String(c._id), { groqJson: chocolate });
  assert.equal((await run()).action, 'created'); assert.equal((await run()).action, 'unchanged'); // reading again changes nothing
  assert.equal(await Order.countDocuments({ source: 'instagram', customerContact: '17841400000555' }), 1);
  const o = await Order.findOne({ source: 'instagram', customerContact: '17841400000555' }).lean();
  assert.deepEqual([o.status, o.customisation], ['draft', 'Happy Birthday Aanya']);
  assert.equal(String((await Conversation.findById(c._id).lean()).orderId), String(o._id));
  assert.ok(!(await api('GET', '/planner?dataset=real&days=30')).json.schedule.some((e) => e.orderId === String(o._id))); // not scheduled until confirmed
  const q = await Conversation.findOne({ channel: 'instagram', contactId: '17841400000042' }); // an enquiry-only chat
  assert.equal((await autoDraftForConversation(String(q._id), { groqJson: reader([[/./, { item: 'Cupcakes', intent: 'enquiry' }]]) })).action, 'skipped');
});

test('27. demo mode is untouched by Instagram: the five demo orders and conversations are still there and never returned as real', { skip }, async () => {
  assert.equal(await Order.countDocuments({ notes: /^\[DEMO\]/ }), 5);
  const real = (await api('GET', '/conversations?dataset=real')).json.items; const demo = (await api('GET', '/conversations?dataset=demo')).json.items;
  assert.ok(real.every((x) => !x.isDemo) && demo.length === 5 && demo.every((x) => x.isDemo));
  assert.ok(real.some((x) => x.channel === 'instagram') && real.some((x) => x.channel === 'whatsapp'));
});

// ---- Settings: what Instagram reports before, during and after the sign-in (no token is ever required to START it) ------------------------------------
import { instagramConnectReadiness } from '../services/integrations/oauth.js';

test('28. Instagram connect readiness: Unified Login needs the Meta app, the configuration id, the encryption key and the server URL, and never an access token or account id', () => {
  const base = { encryptionKey: KEY, serverUrl: 'https://api.example.com', meta: { appId: '123', appSecret: 's', graphVersion: 'v26.0', instagram: { mode: 'unified', loginConfigId: '1679980733491845', accessToken: '', businessAccountId: '', appId: '', appSecret: '' } } };
  const ok = instagramConnectReadiness(base);
  assert.deepEqual([ok.ready, ok.missing, ok.mode], [true, [], 'unified']); // no INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_BUSINESS_ACCOUNT_ID anywhere
  const miss = instagramConnectReadiness({ ...base, serverUrl: '', encryptionKey: '', meta: { ...base.meta, appSecret: '', instagram: { ...base.meta.instagram, loginConfigId: '' } } });
  assert.deepEqual(miss.missing, ['META_APP_SECRET', 'INSTAGRAM_LOGIN_CONFIG_ID', 'ENCRYPTION_KEY', 'SERVER_URL']);
  const legacy = instagramConnectReadiness({ ...base, meta: { ...base.meta, instagram: { ...base.meta.instagram, mode: 'instagram_login', loginConfigId: '' } } }); // Instagram Login: its own app id/secret, falling back to the Meta pair
  assert.deepEqual([legacy.ready, legacy.mode], [true, 'instagram_login']);
});

test('29. Settings reports the truth: not connected (with what is missing, or ready to connect), connecting, an abandoned sign-in expiring, connected with the account, then disconnected', { skip }, async () => {
  const off = unifiedOn(); const saved = { s: config.serverUrl };
  const card = async () => { clearStatusCache(); return (await api('GET', '/integrations')).json.items.find((i) => i.channel === 'instagram'); };
  try {
    await Integration.deleteOne({ channel: 'instagram' });
    let c = await card();
    assert.deepEqual([c.state, c.connect.ready], ['not_connected', true]); assert.match(c.statusReason, /Use Connect to sign in/); assert.ok(!/INSTAGRAM_ACCESS_TOKEN|INSTAGRAM_BUSINESS_ACCOUNT_ID/.test(c.statusReason));
    config.serverUrl = ''; c = await card(); // a missing server setting is named, and Connect is not offered
    assert.deepEqual([c.state, c.connect.ready, c.connect.missing], ['not_connected', false, ['SERVER_URL']]); assert.match(c.statusReason, /the server still needs: SERVER_URL/);
    config.serverUrl = saved.s;
    // Starting the sign-in marks it as connecting (and creates nothing else); a sign-in left unfinished falls back after ten minutes.
    assert.equal((await api('POST', '/integrations/instagram/oauth/start', {})).status, 200);
    c = await card(); assert.equal(c.state, 'connecting'); assert.match(c.statusReason, /finish signing in/);
    await Integration.updateOne({ channel: 'instagram' }, { $set: { oauthStateExpires: new Date(Date.now() - 1000) } });
    assert.equal((await card()).state, 'not_connected'); // Connect is never stuck
    // Finishing it stores the account and the card shows it, from Meta's own answer.
    const state = new URL((await instagramStart()).url).searchParams.get('state');
    await instagramComplete({ code: 'c', state }, { fetchImpl: fakeMeta().fn });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => (String(url).startsWith(base) ? realFetch(url, init) : json({ id: '17841400000001', username: 'sweetcrumbs' }));
    try { c = await card(); } finally { globalThis.fetch = realFetch; }
    assert.deepEqual([c.state, c.accountLabel, c.source], ['connected', '@sweetcrumbs', 'oauth']); assert.ok(!JSON.stringify(c).includes('SUAT'));
    assert.equal((await api('POST', '/integrations/instagram/disconnect')).json.status, 'disconnected');
    c = await card(); assert.deepEqual([c.state, c.accountLabel], ['not_connected', null]);
  } finally { config.serverUrl = saved.s; off(); clearStatusCache(); }
});
