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
import { sendReply, sendTemplateReply } from '../services/replyService.js';
import { retryMedia, mediaIdle } from '../services/messageService.js';

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
const hook = async (channel, payload, { signature } = {}) => { const raw = JSON.stringify(payload); const r = await fetch(`${base}/webhooks/${channel}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature ?? sign(raw) }, body: raw }); const json = await r.json().catch(() => null); await mediaIdle(); return { status: r.status, json }; }; // the picture downloads after the message is stored: wait for it
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
    assert.deepEqual([sent.delivery.mode, sent.delivery.state], ['real', 'accepted']); // Meta took it; only its webhooks may say sent / delivered / read
    assert.ok(calls.some(([u, m]) => u.includes('/555000111/messages') && m === 'POST'));
    assert.equal((await Message.findOne({ externalId: 'wamid.SENT1' }).lean()).direction, 'outbound'); // stored under Meta's id, so its receipts can find it
    globalThis.__reject = true;
    await assert.rejects(sendReply(String(conv._id), 'again'), (e) => e.code === 'INVALID_REQUEST' && /Re-engagement/.test(e.message));
    assert.equal(await Message.countDocuments({ text: 'again' }), 0); // a refused message is not recorded as sent
    delete globalThis.__reject;
    await Message.updateMany({ conversation: conv._id, direction: { $ne: 'outbound' } }, { $set: { receivedAt: new Date(Date.now() - 30 * 3600000) } }); // the customer last wrote 30 hours ago
    await assert.rejects(sendReply(String(conv._id), 'late'), (e) => e.code === 'WINDOW_CLOSED' && /24 hours/.test(e.message));
    assert.equal(calls.filter(([u]) => u.includes('/messages')).length, 2); // the late message never reached Meta
  } finally { globalThis.fetch = realFetch; Object.assign(config.meta.whatsapp, { accessToken: '', phoneNumberId: '' }); clearStatusCache(); }
});

test('10. without Meta credentials the app runs: integrations report "not connected", a reply to a real customer is refused (never faked as delivered), and nothing crashes', { skip }, async () => {
  clearStatusCache();
  const items = (await api('GET', '/integrations')).json;
  assert.deepEqual(items.items.map((i) => [i.channel, i.state]), [['whatsapp', 'not_connected'], ['instagram', 'not_connected']]);
  assert.equal(items.webhooks.whatsapp, 'https://api.example.com/api/webhooks/whatsapp');
  assert.equal((await api('GET', '/health')).json.status, 'ok');
  const conv = await Conversation.findOne({ contactId: '17841400000042' });
  const before = await Message.countDocuments({ conversation: conv._id });
  await assert.rejects(sendReply(String(conv._id), 'Thanks for asking!'), (e) => e.code === 'NOT_CONNECTED' && /not connected/i.test(e.message));
  assert.equal(await Message.countDocuments({ conversation: conv._id }), before); // nothing stored as if it had been sent
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

// ---- One body of data: a confirmed WhatsApp order joins Orders, Plan, Insights and Payments; What-if never saves -------------------------------------
test('30. unified flow: a confirmed WhatsApp order sits beside the existing orders, the Plan and Insights recompute from it, and What-if saves nothing', { skip }, async () => {
  const from = '919855555555';
  const orders = async () => (await api('GET', '/orders?pageSize=100')).json.items; // no dataset: everything is one set
  const planOf = async () => (await api('GET', '/planner?days=30')).json;
  const total = async () => (await api('GET', '/analytics/summary?range=90')).json;
  const beforeOrders = await orders(); const beforePlan = await planOf(); const beforeInsights = await total();
  assert.ok(['Aanya Sharma', 'Kartik Singh', 'Neha Sharma', 'Meera Iyer'].every((n) => beforeOrders.some((o) => o.customerName === n)));

  assert.equal((await hook('whatsapp', text('wamid.U1', 'Hi, I want to order a chocolate cake. 2 kg, for tomorrow at 5 PM.', from))).json.stored, 1);
  const conv = await Conversation.findOne({ contactId: from });
  assert.equal((await autoDraftForConversation(String(conv._id), { groqJson: chocolate })).action, 'created');
  const draft = await Order.findOne({ customerContact: from }).lean();
  assert.equal(draft.status, 'draft');
  // a draft is visible in Orders but is not workload and not revenue until the owner confirms it
  assert.equal((await planOf()).schedule.length, beforePlan.schedule.length);
  assert.equal((await total()).kpis ? JSON.stringify((await total()).kpis) : '', beforeInsights.kpis ? JSON.stringify(beforeInsights.kpis) : '');

  assert.equal((await api('PATCH', `/orders/${draft._id}`, { status: 'confirmed', prepTimeMinutes: 90, price: 1800 })).status, 200);
  const afterOrders = await orders();
  assert.equal(afterOrders.length, beforeOrders.length + 1); // exactly one new record, beside the existing ones
  assert.equal(afterOrders.filter((o) => o.customerContact === from).length, 1);
  for (const o of beforeOrders.filter((x) => x.status !== 'draft')) assert.ok(afterOrders.some((x) => x.id === o.id), `${o.customerName} is still there`);
  const plan = await planOf();
  assert.equal(plan.schedule.length, beforePlan.schedule.length + 1);
  assert.ok(plan.schedule.some((e) => e.orderId === String(draft._id)));
  for (const e of beforePlan.schedule) assert.ok(plan.schedule.some((x) => x.orderId === e.orderId), 'existing orders stay in the plan');
  const after = await total();
  assert.notEqual(JSON.stringify(after.kpis), JSON.stringify(beforeInsights.kpis)); // Insights recomputed from the new record

  // What-if is a proposal only: running it leaves the saved plan exactly as it was
  const snapshot = JSON.stringify((await planOf()).schedule.map((e) => [e.orderId, e.start, e.end]));
  const ov = (await api('GET', '/planner/whatif?scope=commitment')).json;
  const pick = ov.orders?.[0] ?? ov.candidates?.[0];
  if (pick) await api('POST', '/planner/whatif/move', { scope: 'commitment', orderId: pick.id, deadline: pick.deadline });
  assert.equal(JSON.stringify((await planOf()).schedule.map((e) => [e.orderId, e.start, e.end])), snapshot);
});

// ---- The reported WhatsApp scenario: a cake picture, "payment screenshot of rs 500" + a screenshot, "I want the Cake tmrw 3 pm" -------------------------
test('31. picture received while the token was dead is kept with the reason, recovered by a retry, and the chat still becomes ONE draft (Cake, tomorrow 3 PM, no invented quantity)', { skip }, async () => {
  const from = '919866666666'; const png = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'assets', 'demo', 'pay-aanya-upi.png'));
  const realFetch = globalThis.fetch; let tokenOk = false; const mk = (id, extra, name = 'Riya Das') => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { contacts: [{ wa_id: from, profile: { name } }], messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), ...extra }] } }] }] });
  Object.assign(config.meta.whatsapp, { accessToken: 'EAAexpired', phoneNumberId: '555000222' }); clearStatusCache();
  globalThis.fetch = async (url, init) => {
    const u = String(url); if (u.startsWith(base)) return realFetch(url, init);
    if (/\/MEDIA1$/.test(u)) return tokenOk ? new Response(JSON.stringify({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1' }), { status: 200 }) : new Response(JSON.stringify({ error: { message: 'Session has expired', code: 190 } }), { status: 401 });
    if (u.includes('lookaside.fbsbx.com')) return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } });
    return new Response('{}', { status: 200 });
  };
  try {
    // 1. the cake picture arrives while Meta refuses the token: the message is kept, with the reason and what is needed to retry
    assert.equal((await hook('whatsapp', mk('wamid.S1', { type: 'image', image: { id: 'MEDIA1' } }))).json.stored, 1);
    let m = await Message.findOne({ externalId: 'wamid.S1' }).lean();
    assert.equal(m.attachment, null); assert.equal(m.media.id, 'MEDIA1'); assert.match(m.media.error, /expired|revoked/); assert.doesNotMatch(JSON.stringify(m), /EAAexpired/);
    // 2 + 3. the texts arrive; a webhook retry of any of them creates nothing new
    assert.equal((await hook('whatsapp', mk('wamid.S2', { type: 'text', text: { body: 'This is the payment screenshot of rs 500' } }))).json.stored, 1);
    const last = mk('wamid.S3', { type: 'text', text: { body: 'I want the Cake tmrw 3 pm' } });
    assert.equal((await hook('whatsapp', last)).json.stored, 1); assert.deepEqual([(await hook('whatsapp', last)).json.stored, (await hook('whatsapp', last)).json.duplicates], [0, 1]);
    const conv = await Conversation.findOne({ contactId: from });
    // 4. the token is reconnected: the retry downloads the picture (and nothing else changes)
    tokenOk = true; const back = await retryMedia({ conversationId: String(conv._id) });
    assert.equal(back.recovered, 1); m = await Message.findOne({ externalId: 'wamid.S1' }).lean(); assert.ok(m.attachment?.file); assert.equal(m.media.error, null);
    assert.equal((await retryMedia({ conversationId: String(conv._id) })).recovered, 0);
    // 5. read as one conversation: Cake, tomorrow 3 PM in the business timezone, quantity left for the owner
    const cake = reader([[/Cake/, { item: 'Cake', intent: 'order', deadlineDate: ymdTomorrow(), deadlineTime: '15:00' }]]);
    const r = await autoDraftForConversation(String(conv._id), { groqJson: cake, skipMedia: true });
    assert.equal(r.action, 'created');
    const o = await Order.findOne({ customerContact: from }).lean();
    assert.deepEqual([o.status, o.item, o.source], ['draft', 'Cake', 'whatsapp']); assert.equal(o.quantity, 1); // the schema default; the draft flags it as unconfirmed
    assert.equal(new Date(o.deadline).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }), '15:00');
    assert.ok(o.draft.missingFields.includes('quantity')); // flagged for the owner, never silently assumed
    assert.equal(await Order.countDocuments({ customerContact: from }), 1);
    // the cake picture is the order's reference; no payment is verified by any of this
    assert.ok(!(await Payment.find({ order: o._id }).lean()).some((p) => p.status === 'verified'));
  } finally { globalThis.fetch = realFetch; Object.assign(config.meta.whatsapp, { accessToken: '', phoneNumberId: '' }); clearStatusCache(); }
});

// ---- Live updates ----------------------------------------------------------------------------------------------------------------------------------
test('32. live updates: a stored WhatsApp message is announced to an open browser (Server-Sent Events) at once, without waiting for the AI, and a reconnecting browser is told what it missed', { skip }, async () => {
  const open = async (lastId) => {
    const ctrl = new AbortController(); const res = await fetch(`${base}/events`, { headers: lastId ? { 'Last-Event-ID': String(lastId) } : {}, signal: ctrl.signal });
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    const next = async (re, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (re.test(buf)) return buf; const t = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r(null), 200))]); if (t && !t.done) buf += dec.decode(t.value); } return null; };
    return { next, close: () => ctrl.abort(), get text() { return buf; } };
  };
  const a = await open(); assert.ok(await a.next(/event: hello/));
  const t0 = Date.now();
  assert.equal((await hook('whatsapp', text('wamid.L1', 'Hi, I want a cake', '919877777777'))).json.stored, 1);
  const got = await a.next(/event: change\ndata: \{"topic":"messages"/); assert.ok(got, 'the browser was told'); assert.ok(Date.now() - t0 < 2000);
  const conv = await Conversation.findOne({ contactId: '919877777777' });
  assert.ok(a.text.includes(String(conv._id)), 'it says which conversation changed');
  const lastId = Number([...a.text.matchAll(/^id: (\d+)/gm)].pop()[1]); a.close();
  // a browser that was away is told about what happened meanwhile
  assert.equal((await hook('whatsapp', text('wamid.L2', 'Make it 2 kg', '919877777777'))).json.stored, 1);
  await new Promise((r) => setTimeout(r, 400));
  const b = await open(lastId); assert.ok(await b.next(/event: change\ndata: \{"topic":"messages"/), 'missed events are replayed'); b.close();
  // the message is in the Inbox's data whatever the AI does
  const item = (await api('GET', '/conversations')).json.items.find((c) => c.id === String(conv._id));
  assert.deepEqual(item.messages.map((m) => m.text), ['Hi, I want a cake', 'Make it 2 kg']);
});

// ---- Test connection: real checks, with the reasons --------------------------------------------------------------------------------------------------
test('33. Test connection asks Meta and the public address for real: a refused token and an unreachable address are reported with their reason, a healthy setup passes, and no token is ever returned', { skip }, async () => {
  await Integration.deleteMany({}); clearStatusCache();
  const none = (await api('POST', '/integrations/whatsapp/test')).json;
  assert.equal(none.ok, false); assert.equal(none.steps[0].id, 'credentials'); assert.equal(none.steps[0].ok, false);
  const realFetch = globalThis.fetch; let tokenOk = false;
  Object.assign(config.meta.whatsapp, { accessToken: 'EAAsecretvalue', phoneNumberId: '555000333', businessAccountId: 'WABA1' }); clearStatusCache();
  globalThis.fetch = async (url, init) => {
    const u = String(url); if (u.startsWith(base)) return realFetch(url, init);
    if (u.startsWith('https://api.example.com/api/webhooks/whatsapp')) return new Response('{}', { status: tokenOk ? 403 : 0 || 502 });
    if (/\/555000333\?/.test(u)) return tokenOk ? new Response(JSON.stringify({ display_phone_number: '+1 555-160-1991', verified_name: 'Test' }), { status: 200 }) : new Response(JSON.stringify({ error: { message: 'Session has expired' } }), { status: 401 });
    if (/WABA1\/subscribed_apps/.test(u)) return new Response(JSON.stringify({ data: [{ whatsapp_business_api_data: { id: config.meta.appId } }] }), { status: 200 });
    if (/subscriptions/.test(u)) return new Response(JSON.stringify({ error: { message: 'API access blocked.' } }), { status: 400 });
    return new Response('{}', { status: 200 });
  };
  try {
    const bad = (await api('POST', '/integrations/whatsapp/test')).json; const by = (r, id) => r.steps.find((s) => s.id === id);
    assert.equal(bad.ok, false); assert.equal(by(bad, 'token').ok, false); assert.match(by(bad, 'token').detail, /Session has expired/); assert.equal(by(bad, 'public_url').ok, false);
    tokenOk = true; clearStatusCache();
    const good = (await api('POST', '/integrations/whatsapp/test')).json;
    assert.equal(by(good, 'token').ok, true); assert.equal(by(good, 'subscription').ok, true); assert.equal(by(good, 'public_url').ok, true); assert.equal(by(good, 'callback').ok, null); // Meta would not say
    assert.ok(!JSON.stringify([bad, good]).includes('EAAsecretvalue'));
  } finally { globalThis.fetch = realFetch; Object.assign(config.meta.whatsapp, { accessToken: '', phoneNumberId: '', businessAccountId: '' }); clearStatusCache(); }
  const d = (await api('GET', '/integrations/whatsapp/diagnostics')).json;
  assert.ok(d.lastIncomingAt && d.webhook.lastReceivedAt && 'media' in d);
});

test('34. a healthy WhatsApp setup passes every check (permissions, account, subscription); failures are explained by kind; registering the webhook points Meta at SERVER_URL', { skip }, async () => {
  const realFetch = globalThis.fetch; let mode = 'good'; const posts = [];
  Object.assign(config.meta.whatsapp, { accessToken: 'EAAsecretvalue2', phoneNumberId: '555000444', businessAccountId: 'WABA2' }); clearStatusCache();
  globalThis.fetch = async (url, init) => {
    const u = String(url); if (u.startsWith(base)) return realFetch(url, init);
    if ((init?.method ?? 'GET') === 'POST') { posts.push(u); return new Response(JSON.stringify({ success: true }), { status: 200 }); }
    if (u.startsWith('https://api.example.com/')) return new Response('{}', { status: 403 });
    if (/debug_token/.test(u)) return new Response(JSON.stringify({ data: { is_valid: true, scopes: mode === 'noperm' ? ['whatsapp_business_management'] : ['whatsapp_business_messaging', 'whatsapp_business_management'], expires_at: 0 } }), { status: 200 });
    if (/\/555000444\?/.test(u)) return mode === 'forbidden' ? new Response(JSON.stringify({ error: { message: 'Permissions error', code: 200 } }), { status: 403 }) : mode === 'badid' ? new Response(JSON.stringify({ error: { message: 'Unsupported get request', code: 100 } }), { status: 400 }) : new Response(JSON.stringify({ display_phone_number: '+1 555-160-1991', verified_name: 'Test' }), { status: 200 });
    if (/WABA2\/phone_numbers/.test(u)) return new Response(JSON.stringify({ data: [{ id: '555000444' }] }), { status: 200 });
    if (/WABA2\/subscribed_apps/.test(u)) return new Response(JSON.stringify({ data: [{ whatsapp_business_api_data: { id: config.meta.appId } }] }), { status: 200 });
    if (/subscriptions/.test(u)) return new Response(JSON.stringify({ data: [{ object: 'whatsapp_business_account', callback_url: 'https://api.example.com/api/webhooks/whatsapp' }] }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  const run = async () => (await api('POST', '/integrations/whatsapp/test')).json; const by = (r, id) => r.steps.find((s) => s.id === id);
  try {
    const good = await run(); assert.equal(good.ok, true, JSON.stringify(good.steps.filter((s) => s.ok !== true)));
    for (const id of ['token', 'permissions', 'waba', 'subscription', 'public_url', 'callback']) assert.equal(by(good, id).ok, true, id);
    mode = 'noperm'; clearStatusCache(); const np = await run(); assert.equal(by(np, 'permissions').ok, false); assert.match(by(np, 'permissions').detail, /whatsapp_business_messaging/);
    mode = 'forbidden'; clearStatusCache(); const fb = await run(); assert.match(by(fb, 'token').detail, /lacks permission/);
    mode = 'badid'; clearStatusCache(); const bi = await run(); assert.match(by(bi, 'token').detail, /does not recognise that id/);
    const reg = (await api('POST', '/integrations/whatsapp/register-webhook')).json;
    assert.equal(reg.ok, true); assert.ok(posts.some((u) => /\/1234567890\/subscriptions/.test(u))); assert.ok(posts.some((u) => /WABA2\/subscribed_apps/.test(u)));
    assert.ok(!JSON.stringify([good, np, fb, bi, reg]).includes('EAAsecretvalue2'));
  } finally { globalThis.fetch = realFetch; Object.assign(config.meta.whatsapp, { accessToken: '', phoneNumberId: '', businessAccountId: '' }); clearStatusCache(); }
});

// ---- One order, three pages ---------------------------------------------------------------------------------------------------------------------------
test('35. a real order flows into Plan, What-if and Insights whatever its source; demo fixtures never hide it; drafts, completed and cancelled follow their rules; a simulation saves nothing', { skip }, async () => {
  const base0 = { prepTimeMinutes: 45, price: 900, quantity: 1 };
  const soon = (h) => new Date(Date.now() + h * 3600000).toISOString();
  const mk = async (o) => { const r = await api('POST', '/orders', { ...base0, ...o }); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json; };
  const demoBefore = (await Order.find({ notes: /^\[DEMO\]/ }).lean()).map((o) => [String(o._id), o.customerName, +new Date(o.deadline)]);
  assert.equal(demoBefore.length, 5);
  const wa = await mk({ customerName: 'Real WA', item: 'Cake', deadline: soon(60), status: 'confirmed', source: 'whatsapp' });
  const ig = await mk({ customerName: 'Real IG', item: 'Pastries', deadline: soon(62), status: 'confirmed', source: 'instagram' });
  const man = await mk({ customerName: 'Real Manual', item: 'Cupcakes', deadline: soon(64), status: 'in_progress', source: 'manual' });
  const done = await mk({ customerName: 'Real Done', item: 'Cake', deadline: soon(66), status: 'completed', source: 'manual' });
  const cancelled = await mk({ customerName: 'Real Cancelled', item: 'Cake', deadline: soon(68), status: 'cancelled', source: 'manual' });
  const draft = await mk({ customerName: 'Real Draft', item: 'Cake', deadline: soon(70), status: 'draft', source: 'whatsapp' });
  const real = [wa, ig, man];

  // Plan
  const plan = (await api('GET', '/planner?days=14')).json; const planned = new Set(plan.schedule.map((e) => e.orderId));
  for (const o of real) assert.ok(planned.has(o.id), `${o.customerName} is in the Plan`);
  for (const o of [done, cancelled, draft]) assert.ok(!planned.has(o.id), `${o.customerName} is not planned`);
  // What-if (the real set, by default) uses the same orders and the same engine
  const wi = (await api('GET', '/planner/whatif?scope=all')).json; const inWi = new Set(wi.cards.map((c) => c.id));
  for (const o of real) assert.ok(inWi.has(o.id), `${o.customerName} is in What-if`);
  for (const o of [done, cancelled, draft]) assert.ok(!inWi.has(o.id));
  assert.ok(wi.awaiting.some((a) => a.id === draft.id), 'the draft is reported, not silently dropped');
  assert.ok(wi.cards.some((c) => /Aanya|Kartik/.test(c.customerName)), 'the sample customers are still there, beside the real orders');
  // Insights count them (business timezone, current period); a cancelled order is not completed revenue and a draft is not counted
  const ins = (await api('GET', '/analytics/summary?range=7')).json;
  const total = ins.kpis.totalOrders.value;
  const expected = (await Order.countDocuments({ status: { $nin: ['draft', 'cancelled'] }, createdAt: { $gte: new Date(Date.now() - 7 * 86400000) } }));
  assert.equal(total, expected); assert.ok(ins.awaiting.some((a) => a.id === draft.id));
  const revenue = ins.kpis.totalRevenue.value; const orderRows = await Order.find({ status: { $ne: 'draft' }, createdAt: { $gte: new Date(Date.now() - 7 * 86400000) } }).lean();
  assert.ok(revenue <= orderRows.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + (o.price ?? 0), 0), 'cancelled orders are not revenue');
  // A simulation changes nothing stored
  const before = JSON.stringify(await Order.find({}).sort({ _id: 1 }).lean());
  const sim = (await api('POST', '/planner/whatif/move', { scope: 'all', orderId: wa.id, deadline: soon(30) })).json;
  assert.equal(sim.ok, true); assert.ok(sim.after.cards.some((c) => c.id === wa.id) && sim.after.cards.some((c) => c.id === ig.id), 'every order is re-planned');
  assert.equal(JSON.stringify(await Order.find({}).sort({ _id: 1 }).lean()), before);
  // Demo fixtures intact, nothing duplicated
  const demoAfter = (await Order.find({ notes: /^\[DEMO\]/ }).lean()).map((o) => [String(o._id), o.customerName, +new Date(o.deadline)]);
  assert.deepEqual(demoAfter, demoBefore);
  const names = (await Order.find({}).lean()).map((o) => o.customerName); assert.equal(new Set(names.filter((n) => /^Real /.test(n))).size, 6);
  // Re-seeding the demo never touches real orders
  await reseedDemoOrders(new Date());
  assert.equal(await Order.countDocuments({ customerName: /^Real / }), 6); assert.equal(await Order.countDocuments({ notes: /^\[DEMO\]/ }), 5);
});

test('36. the Insights story comes from the database: money split into booked / collected / outstanding, people from real conversations, the week from creation dates, three discoveries', { skip }, async () => {
  const ins = (await api('GET', '/analytics/summary?range=30')).json; const s = ins.story;
  assert.ok(s && s.money && s.orders && s.people && s.week && s.popular && s.busiest && s.regular);
  assert.equal(s.week.days.length, 7); assert.equal(s.week.days[0].weekday, 'Monday'); assert.equal(s.week.days[6].weekday, 'Sunday');
  const live = await Order.countDocuments({ status: { $nin: ['draft', 'cancelled'] }, createdAt: { $gte: new Date(s.week.from + 'T00:00:00+05:30'), $lt: new Date(new Date(s.week.to + 'T00:00:00+05:30').getTime() + 86400000) } });
  assert.equal(s.week.total, live, 'the week counts the same orders as the database');
  assert.equal(s.orders.value, ins.kpis.totalOrders.value);
  assert.ok(s.money.collected <= s.money.booked && Math.abs(s.money.booked - s.money.collected - s.money.outstanding) < 0.01);
  assert.ok(s.people.value >= 1 && s.people.value <= await Conversation.countDocuments());
  assert.equal((await api('GET', '/analytics/summary?range=7&week=2026-11-02')).json.story.week.from, '2026-11-02');
  assert.equal((await api('GET', '/analytics/summary?week=nope')).status, 400);
});

import { promoteReadyDrafts, missingForPlan } from '../services/orderService.js';
test('37. a request the owner has reviewed and completed becomes a real order (and is planned); an untouched one stays a draft; what is "missing" is read from the order itself', { skip }, async () => {
  const soon = (h) => new Date(Date.now() + h * 3600000).toISOString();
  const draft = (await api('POST', '/orders', { customerName: 'Review Me', item: 'pineapple cake', quantity: 2, status: 'draft', source: 'whatsapp' })).json;
  assert.deepEqual(missingForPlan(await Order.findById(draft.id).lean()), ['deadline', 'prepTimeMinutes']);
  const planned = async () => new Set((await api('GET', '/planner?days=14')).json.schedule.map((e) => e.orderId));
  // an edit that leaves something missing keeps it a draft, and the Plan page's "awaiting" list says exactly what is missing now
  assert.equal((await api('PATCH', `/orders/${draft.id}`, { notes: 'asked for extra cream' })).json.status, 'draft');
  const w = (await api('GET', '/planner/whatif?scope=all')).json.awaiting.find((a) => a.id === draft.id); assert.deepEqual(w.missing, ['deadline', 'prepTimeMinutes']);
  assert.ok(!(await planned()).has(draft.id));
  // complete and untouched by the startup check: still a draft (nobody reviewed it)
  await Order.updateOne({ _id: draft.id }, { $set: { deadline: soon(30), prepTimeMinutes: 120 } });
  assert.deepEqual(await promoteReadyDrafts(), []); assert.equal((await Order.findById(draft.id)).status, 'draft');
  // the owner saves it: now it is an order, in the Plan, with the quantity kept as the number 2
  assert.equal((await api('PATCH', `/orders/${draft.id}`, { notes: 'reviewed' })).json.status, 'draft'); // a note alone never confirms it
  const saved = (await api('PATCH', `/orders/${draft.id}`, { prepTimeMinutes: 90 })).json;
  assert.equal(saved.status, 'confirmed'); assert.ok((await planned()).has(draft.id));
  const o = await Order.findById(draft.id).lean(); assert.equal(o.quantity, 2); assert.equal(typeof o.quantity, 'number');
  assert.ok(!(await api('GET', '/planner/whatif?scope=all')).json.awaiting.some((a) => a.id === draft.id));
  // putting it explicitly back to draft is respected
  assert.equal((await api('PATCH', `/orders/${draft.id}`, { status: 'draft' })).json.status, 'draft');
});

test('38. deleting an order really removes it: gone from Orders, Plan, What-if and Insights; its payments go, its chat is unlinked but kept; other orders are untouched; a second delete is a 404', { skip }, async () => {
  const soon = (h) => new Date(Date.now() + h * 3600000).toISOString();
  const keep = (await api('POST', '/orders', { customerName: 'Keep Me', item: 'Cake', quantity: 1, prepTimeMinutes: 30, deadline: soon(50), status: 'confirmed', source: 'manual', price: 700 })).json;
  const gone = (await api('POST', '/orders', { customerName: 'Delete Me', item: 'Cake', quantity: 1, prepTimeMinutes: 30, deadline: soon(52), status: 'confirmed', source: 'whatsapp', price: 900 })).json;
  const conv = await Conversation.create({ channel: 'whatsapp', contactId: '919800099999', customerName: 'Delete Me', orderId: gone.id });
  await Message.create({ conversation: conv._id, channel: 'whatsapp', externalId: 'wamid.DEL1', text: 'hello', messageType: 'text', receivedAt: new Date() });
  await Payment.create({ order: gone.id, amount: 300, method: 'upi', status: 'confirmed', source: 'manual', paidAt: new Date() });
  const insBefore = (await api('GET', '/analytics/summary?range=7')).json.kpis.totalOrders.value;
  const demoBefore = await Order.countDocuments({ notes: /^\[DEMO\]/ });

  const r = await api('DELETE', `/orders/${gone.id}`); assert.equal(r.status, 200); assert.equal(r.json.deleted, true);
  assert.equal(await Order.countDocuments({ _id: gone.id }), 0); assert.equal(await Payment.countDocuments({ order: gone.id }), 0);
  assert.equal((await Conversation.findById(conv._id).lean()).orderId, null); assert.equal(await Message.countDocuments({ conversation: conv._id }), 1);
  assert.ok(!(await api('GET', '/orders?pageSize=100')).json.items.some((o) => o.id === gone.id)); assert.equal((await api('GET', `/orders/${gone.id}`)).status, 404);
  assert.ok(!(await api('GET', '/planner?days=14')).json.schedule.some((e) => e.orderId === gone.id));
  assert.ok(!(await api('GET', '/planner/whatif?scope=all')).json.cards.some((c) => c.id === gone.id));
  assert.equal((await api('GET', '/analytics/summary?range=7')).json.kpis.totalOrders.value, insBefore - 1);
  assert.ok((await api('GET', '/orders?pageSize=100')).json.items.some((o) => o.id === keep.id)); assert.equal(await Order.countDocuments({ notes: /^\[DEMO\]/ }), demoBefore);
  assert.equal((await api('DELETE', `/orders/${gone.id}`)).status, 404); assert.equal((await api('DELETE', '/orders/not-an-id')).status, 404);
});

test('39. What-if keeps the Aanya/Kartik 10:30 demonstration AND includes the business\'s own open orders: one due before the demo morning is planned first on the real clock, one due after is planned with the five; nothing real is moved or applied away', { skip }, async () => {
  const mk = async (o) => { const r = await api('POST', '/orders', { quantity: 2, prepTimeMinutes: 60, status: 'confirmed', source: 'whatsapp', ...o }); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json; };
  const base = (await api('GET', '/planner/whatif?scope=commitment')).json;
  const kartik = base.cards.find((c) => c.customerName === 'Kartik Singh'); const aanya = base.cards.find((c) => c.customerName === 'Aanya Sharma');
  const t0 = Date.parse(kartik.start); // the demo morning, 9:00 in the business timezone
  const early = await mk({ customerName: 'Real Early', item: 'pineapple cake', deadline: new Date(t0 - 20 * 3600000).toISOString() }); // due the day before the demo morning
  const late = await mk({ customerName: 'Real Late', item: 'brownies', deadline: new Date(t0 + 30 * 3600000).toISOString() }); // due the day after
  const draft = await mk({ customerName: 'Real Draft', item: 'cake', status: 'draft', deadline: new Date(t0 + 10 * 3600000).toISOString() });
  const before = JSON.stringify(await Order.find({ customerName: /^Real / }).sort({ _id: 1 }).lean());

  const wi = (await api('GET', '/planner/whatif?scope=commitment')).json; const names = wi.cards.map((c) => c.customerName);
  assert.ok(names.includes('Real Early') && names.includes('Real Late'), 'both real orders are in the sequence');
  assert.ok(!names.includes('Real Draft') && wi.awaiting.some((a) => a.id === draft.id), 'a draft is reported, not planned');
  assert.ok(names.indexOf('Real Early') < names.indexOf('Kartik Singh'), 'the order due first is produced first (real clock)');
  const k = wi.cards.find((c) => c.customerName === 'Kartik Singh'); const a = wi.cards.find((c) => c.customerName === 'Aanya Sharma');
  assert.equal(k.start, kartik.start); assert.equal(k.end, kartik.end); assert.equal(a.start, aanya.start); assert.equal(a.end, aanya.end); // the demonstration is untouched
  assert.ok(Date.parse(k.end) <= Date.parse(k.deadline) && Date.parse(a.end) <= Date.parse(a.deadline), 'both 10:30 promises are still kept');
  const e = wi.cards.find((c) => c.customerName === 'Real Early'); assert.equal(e.prepTimeMinutes, 60); assert.equal(e.deadline, early.deadline);
  // running the simulation re-plans every order, real ones included, and saves nothing
  const run = (await api('POST', '/planner/whatif/move', { scope: 'commitment', orderId: k.id, deadline: k.deadline })).json;
  assert.equal(run.ok, true); const after = run.after.cards.map((c) => c.customerName);
  assert.ok(after.includes('Real Early') && after.includes('Real Late') && after.indexOf('Kartik Singh') < after.indexOf('Aanya Sharma'));
  assert.equal(JSON.stringify(await Order.find({ customerName: /^Real / }).sort({ _id: 1 }).lean()), before);
  // Apply to Plan changes only the sample orders' deadlines, never a real order's
  await api('POST', '/planner/whatif/apply', { scope: 'commitment' });
  assert.equal(JSON.stringify(await Order.find({ customerName: /^Real / }).sort({ _id: 1 }).lean()), before);
  assert.equal(String((await Order.findById(early.id).lean()).deadline.toISOString()), early.deadline);
});

test('40. real WhatsApp sending end to end (against a fake Meta): the request carries the E.164 recipient and the phone number id, the wamid is stored, "accepted" only becomes sent / delivered / read through webhooks, failures are explained and never recorded, and the window rule offers a template', { skip }, async () => {
  const realFetch = globalThis.fetch; const sent = []; let reply = { status: 200, body: { messages: [{ id: 'wamid.REAL1' }] } };
  Object.assign(config.meta.whatsapp, { accessToken: 'EAAsendsecret', phoneNumberId: '555000777' }); clearStatusCache();
  globalThis.fetch = async (url, init) => {
    const u = String(url); if (u.startsWith(base)) return realFetch(url, init);
    if (u.includes('/555000777/messages')) { sent.push({ url: u, auth: init.headers.Authorization, body: JSON.parse(init.body) }); return new Response(JSON.stringify(reply.body), { status: reply.status }); }
    return new Response(JSON.stringify({ display_phone_number: '+1 555 160 1991', verified_name: 'Test' }), { status: 200 }); // the connection check
  };
  try {
    await hook('whatsapp', text('wamid.IN40', 'Hello, is my cake ready?', '919844444444')); const conv = await Conversation.findOne({ contactId: '919844444444' }); const id = String(conv._id);
    // 1. a reply inside the window goes to Meta for real
    const r = await sendReply(id, 'Yes, it will be ready by 3 PM.');
    assert.equal(sent.length, 1); assert.match(sent[0].url, /\/555000777\/messages$/); assert.equal(sent[0].auth, 'Bearer EAAsendsecret');
    assert.deepEqual([sent[0].body.messaging_product, sent[0].body.to, sent[0].body.type, sent[0].body.text.body], ['whatsapp', '919844444444', 'text', 'Yes, it will be ready by 3 PM.']);
    assert.deepEqual([r.delivery.mode, r.delivery.state], ['real', 'accepted']);
    const stored = await Message.findOne({ externalId: 'wamid.REAL1' }).lean(); assert.equal(stored.direction, 'outbound'); assert.equal(stored.delivery.state, 'accepted');
    // 2. only webhooks move it on, and never backwards
    const st = (status, extra = {}) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.REAL1', status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '919844444444', ...extra }] } }] }] });
    for (const [s2, want] of [['sent', 'sent'], ['delivered', 'delivered'], ['read', 'read'], ['delivered', 'read']]) { await hook('whatsapp', st(s2)); assert.equal((await Message.findOne({ externalId: 'wamid.REAL1' }).lean()).delivery.state, want); }
    // 3. refusals: explained, not stored, nothing marked sent
    const count = await Message.countDocuments({ conversation: conv._id });
    reply = { status: 400, body: { error: { code: 131030, message: 'Recipient phone number not in allowed list' } } };
    await assert.rejects(sendReply(id, 'second'), (e) => e.code === 'RECIPIENT_NOT_ALLOWED' && /allowed recipient list/.test(e.message));
    reply = { status: 401, body: { error: { code: 190, message: 'Session has expired' } } };
    await assert.rejects(sendReply(id, 'third'), (e) => e.code === 'TOKEN_INVALID' && /expired/.test(e.message));
    reply = { status: 429, body: { error: { code: 130429, message: 'rate' } } };
    await assert.rejects(sendReply(id, 'fourth'), (e) => e.code === 'RATE_LIMITED');
    assert.equal(await Message.countDocuments({ conversation: conv._id }), count);
    // 4. a Meta failure webhook is shown as not delivered, with its reason
    reply = { status: 200, body: { messages: [{ id: 'wamid.REAL2' }] } }; clearStatusCache(); await Integration.deleteMany({});
    await sendReply(id, 'fifth'); await hook('whatsapp', st('failed', { id: 'wamid.REAL2', errors: [{ code: 131026, title: 'Message undeliverable' }] }));
    const failed = await Message.findOne({ externalId: 'wamid.REAL2' }).lean(); assert.deepEqual([failed.delivery.state, failed.delivery.error], ['failed', 'Message undeliverable']);
    // 5. outside the 24-hour window: no free text, but an approved template can be sent, and it is tracked like any other message
    await Message.updateMany({ conversation: conv._id, direction: 'inbound' }, { $set: { receivedAt: new Date(Date.now() - 30 * 3600000) } }); const n = sent.length;
    reply = { status: 200, body: { messages: [{ id: 'wamid.TPL1' }] } };
    await assert.rejects(sendReply(id, 'too late'), (e) => e.code === 'WINDOW_CLOSED' && /approved template/.test(e.message)); assert.equal(sent.length, n);
    const t = await sendTemplateReply(id); assert.equal(sent.length, n + 1); assert.deepEqual([sent[n].body.type, sent[n].body.template.name, sent[n].body.template.language.code], ['template', 'hello_world', 'en_US']);
    assert.deepEqual([t.delivery.mode, t.delivery.state], ['real', 'accepted']); assert.equal((await Message.findOne({ externalId: 'wamid.TPL1' }).lean()).messageType, 'template');
    // 6. an invalid stored number is refused before Meta is called
    await Conversation.updateOne({ _id: conv._id }, { $set: { contactId: '12' } }); await Message.updateMany({ conversation: conv._id, direction: 'inbound' }, { $set: { receivedAt: new Date() } }); const m = sent.length;
    await assert.rejects(sendReply(id, 'x'), (e) => e.code === 'INVALID_RECIPIENT'); assert.equal(sent.length, m);
    // the token never appears in anything returned
    assert.ok(!JSON.stringify([r, t]).includes('EAAsendsecret'));
  } finally { globalThis.fetch = realFetch; Object.assign(config.meta.whatsapp, { accessToken: '', phoneNumberId: '' }); clearStatusCache(); }
});
