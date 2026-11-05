// The demo Messages -> Orders -> Payments workflow, end to end against a throwaway mongod: the five demo conversations are seeded, their
// pictures and payment screenshots go through the real pipeline, and the three sections (order details, Payments, Messages) must agree.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { createApp } from '../app.js';
import { connectDb } from '../config/db.js';
import { config } from '../config/env.js';
import Order from '../models/Order.js';
import Payment from '../models/Payment.js';
import Message from '../models/Message.js';
import Conversation from '../models/Conversation.js';
import { reseedDemoOrders, reseedDemoMessages, refreshStaleDemo } from '../services/demoSeed.js';
import { processMessageImage } from '../services/paymentAutoDetect.js';
import { extractOrderSpec } from '../services/orderSpec.js';
import { DEMO_CONVERSATIONS, demoVision } from '../scripts/demo-data.js';

// ---- The specification reader on its own ----------------------------------------------------------------------------------
const M = (id, text, min, extra = {}) => ({ id, text, at: new Date(Date.UTC(2026, 9, 29, 10, min)).toISOString(), ...extra });
const field = (spec, key) => spec.fields.find((f) => f.key === key);

test('order specification: product, quantity, message, icing colour and requests come from the customer\'s own words', () => {
  const spec = extractOrderSpec([
    M('1', 'I want a 2 kg chocolate birthday cake.', 0),
    M('2', null, 1, { attachment: { url: '/ref.png' }, scan: { state: 'not_payment' } }),
    M('3', 'Please write "Happy Birthday Laddu" on the cake in blue icing.', 2),
    M('4', 'Dark chocolate ganache please, and no nuts. My nephew is allergic.', 3),
  ]);
  assert.equal(field(spec, 'product').value, 'Chocolate birthday cake');
  assert.equal(field(spec, 'quantity').value, '2 kg');
  assert.equal(field(spec, 'cakeMessage').value, 'Happy Birthday Laddu');
  assert.equal(field(spec, 'icingColour').value, 'Blue');
  assert.equal(field(spec, 'flavour').value, 'Dark chocolate ganache');
  assert.match(spec.specialRequests[0].value, /no nuts/i);
  assert.deepEqual(spec.referenceImages.map((r) => r.messageId), ['2']);
  assert.equal(field(spec, 'cakeMessage').messageId, '3'); // every value points back to the message it came from
});

test('order specification: nothing is invented, a payment screenshot is not a reference image, and an unsorted picture is not shown as either', () => {
  const spec = extractOrderSpec([
    M('1', 'Hi, can you do a cake for Saturday?', 0),
    M('2', 'Paid', 1, { attachment: { url: '/pay.png' }, payment: { id: 'p1' } }),
    M('3', null, 2, { attachment: { url: '/x.png' }, scan: { state: 'processing' } }),
  ]);
  assert.deepEqual(spec.fields.map((f) => [f.key, f.value, f.status]), [['product', null, 'awaiting'], ['quantity', null, 'awaiting'], ['cakeMessage', null, 'awaiting'], ['icingColour', null, 'awaiting'], ['flavour', null, 'awaiting'], ['deadline', null, 'awaiting']]);
  assert.equal(spec.referenceImages.length, 0); assert.deepEqual(spec.unsortedImages.map((i) => i.messageId), ['3']);
});

test('order specification: the latest instruction wins and the earlier ones stay in the history', () => {
  const spec = extractOrderSpec([
    M('1', 'Please write "Happy 30th, Ria" on the cake in blue icing.', 0),
    M('2', 'Oops, change the message to "Happy 31st, Ria" and make the icing pink.', 5),
    M('3', 'Thanks!', 9),
  ]);
  const msg = field(spec, 'cakeMessage'); const icing = field(spec, 'icingColour');
  assert.deepEqual([msg.value, msg.changed, msg.messageId], ['Happy 31st, Ria', true, '2']);
  assert.deepEqual(msg.history.map((h) => [h.value, h.current]), [['Happy 30th, Ria', false], ['Happy 31st, Ria', true]]);
  assert.deepEqual(icing.history.map((h) => h.value), ['Blue', 'Pink']);
  assert.equal(extractOrderSpec([M('1', 'Write "Hi" in blue icing.', 0), M('2', 'Write "Hi" in blue icing.', 1)]).fields[2].changed, false); // repeating is not a change
});

// ---- The seeded demo -------------------------------------------------------------------------------------------------------
const hasMongod = spawnSync('mongod', ['--version']).status === 0;
const skip = hasMongod ? false : 'mongod not installed: integration tests skipped';
let proc; let server; let base; let dir; let proofDir;
const TOTAL = DEMO_CONVERSATIONS.reduce((n, c) => n + c.messages.length, 0);

before(async () => {
  if (!hasMongod) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversa-flow-')); proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversa-flowproof-'));
  config.payments.proofDir = proofDir;
  const port = 30000 + Math.floor(Math.random() * 1000);
  proc = spawn('mongod', ['--dbpath', dir, '--port', String(port), '--bind_ip', '127.0.0.1', '--nounixsocket'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { if (await connectDb(`mongodb://127.0.0.1:${port}/conversa_flow_test`)) break; await new Promise((r) => setTimeout(r, 500)); }
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
  await Payment.init();
  const { created } = await reseedDemoOrders(new Date());
  await reseedDemoMessages(created, new Date());
});
after(async () => { server?.close(); await mongoose.disconnect(); proc?.kill(); for (const d of [dir, proofDir]) if (d) fs.rmSync(d, { recursive: true, force: true }); });

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, json: (r.headers.get('content-type') ?? '').includes('json') ? await r.json() : null, type: r.headers.get('content-type'), bytes: Buffer.from(await r.arrayBuffer().catch(() => new ArrayBuffer(0))) }; };
const orderId = async (name) => String((await Order.findOne({ customerName: name, notes: /^\[DEMO\]/ }))._id);
const convOf = async (name) => (await get(`/orders/${await orderId(name)}/conversation`)).json;
const ledger = async () => (await get('/payments')).json;

test('1. a reference image the customer sent appears in the linked order, served from the stored original', { skip }, async () => {
  const c = await convOf('Neha Sharma');
  assert.equal(c.conversation.isDemo, true); assert.equal(c.conversation.channel, 'whatsapp');
  assert.equal(c.spec.referenceImages.length, 1);
  const img = await get(c.spec.referenceImages[0].url);
  assert.equal(img.status, 200); assert.equal(img.type, 'image/png'); assert.ok(img.bytes.length > 1000);
  const msg = c.messages.find((m) => m.id === c.spec.referenceImages[0].messageId);
  assert.equal(msg.kind, 'reference'); assert.equal(msg.text, 'Something like this.'); // the original message, with its own timestamp
  assert.ok(msg.at);
  for (const name of ['Meera Iyer', 'Rohan Mehta', 'Kartik Singh', 'Aanya Sharma']) assert.equal((await convOf(name)).spec.referenceImages.length, 1, name);
  assert.ok(c.spec.referenceImages.every((r) => !/^https?:/.test(r.url))); // never an external URL
});

test('2. customisation instructions appear in the order specification (and nothing the customer did not say)', { skip }, async () => {
  const s = (await convOf('Neha Sharma')).spec;
  assert.deepEqual(s.fields.map((f) => [f.key, f.value]), [['product', 'Chocolate birthday cake'], ['quantity', '2 kg'], ['cakeMessage', 'Happy Birthday Laddu'], ['icingColour', 'Blue'], ['flavour', 'Dark chocolate ganache'], ['deadline', '12pm']]);
  assert.ok(s.specialRequests.some((r) => /no nuts/i.test(r.value)));
  const k = (await convOf('Kartik Singh')).spec;
  assert.equal(field(k, 'quantity').value, '6'); assert.equal(field(k, 'cakeMessage').value, null); // only what the customer said
  assert.equal(field(k, 'flavour').value, 'Pistachio and rose'); assert.deepEqual(k.decorations.map((d) => d.value), ['gold topper']);
  const m = (await convOf('Meera Iyer')).spec;
  assert.equal(field(m, 'quantity').value, '4'); assert.equal(field(m, 'product').value, 'Chocolate pastries');
  assert.equal(field(m, 'deadline').value, '2:00 PM');
});

test('3. an updated instruction changes the current specification and keeps the history and the original messages', { skip }, async () => {
  const a = await convOf('Aanya Sharma');
  const msg = field(a.spec, 'cakeMessage');
  assert.deepEqual([msg.value, msg.changed], ['Happy Birthday Riya', true]);
  assert.deepEqual(msg.history.map((h) => h.value), ['Happy Birthday Ria', 'Happy Birthday Riya']);
  assert.equal(field(a.spec, 'icingColour').value, 'Blue');
  assert.ok(a.messages.some((m) => /Birthday Ria"/.test(m.text)) && a.messages.some((m) => /Birthday Riya/.test(m.text))); // both messages are still there
  assert.equal((await Order.findOne({ customerName: 'Rohan Mehta', notes: /^\[DEMO\]/ })).quantity, 1); // consistent with the order itself
});

test('4+5. a payment screenshot becomes a payment record linked to the right customer, order and original message', { skip }, async () => {
  const kabir = (await ledger()).rows.find((r) => r.customerName === 'Kartik Singh');
  const auto = kabir.payments.filter((p) => p.source === 'auto_screenshot');
  assert.equal(auto.length, 1);
  const [p] = auto;
  assert.deepEqual([p.amount, p.method, p.transactionId, p.status, p.displayStatus], [720, 'upi', '412398765431', 'pending', 'awaiting_verification']);
  assert.equal(p.extraction.method, 'vision'); assert.equal(p.extraction.model, 'demo (preset reading)'); assert.equal(p.extraction.recipient, 'S***** C****** (partly hidden)');
  assert.equal(p.match.state, 'matched'); assert.ok(p.paidAt && p.proof);
  assert.equal(p.sourceMessage.text, 'Payment done, thank you!'); assert.equal(p.sourceMessage.customerName, 'Kartik Singh'); assert.equal(p.sourceMessage.channel, 'instagram');
  const msg = await Message.findById(p.messageId);
  assert.equal(String(msg.paymentId), p.id); assert.equal(String(msg.conversation), p.conversationId);
  assert.equal(String((await Conversation.findById(msg.conversation)).orderId), kabir.orderId);
  assert.equal((await get(`/payments/${p.id}/proof`)).type, 'image/png'); // the original screenshot, no re-upload
  assert.deepEqual([kabir.paid, kabir.status], [0, 'verification_pending']); // read, not received
  assert.equal((await Order.findById(kabir.orderId)).paymentStatus, 'pending');
  // the same payments, seen from Messages
  const chat = (await get('/conversations')).json.items.find((c) => c.customerName === 'Kartik Singh');
  assert.deepEqual(chat.messages.filter((m) => m.scan?.state === 'filed' || m.scan?.state === 'duplicate').map((m) => m.scan.state), ['filed']);
  assert.ok(chat.messages.filter((m) => m.payment).every((m) => m.payment.id === p.id));
  // Aanya's payment points back at her message too
  const row = (await ledger()).rows.find((r) => r.customerName === 'Aanya Sharma');
  assert.match(row.payments[0].sourceMessage.text, /UTR 426118830517/); assert.equal(row.payments[0].displayStatus, 'verified'); // confirmed by the demo owner, not by a screenshot
});

test('a blurry screenshot with no reference ID is Pending Review, and no screenshot ever marks anything verified', { skip }, async () => {
  const meera = (await ledger()).rows.find((r) => r.customerName === 'Meera Iyer');
  const [p] = meera.payments;
  assert.deepEqual([p.amount, p.transactionId, p.status, p.displayStatus], [320, null, 'pending', 'pending_review']);
  assert.ok(p.match.reviewRequired); assert.match(p.extraction.issues.join(' '), /blurry/i);
  assert.equal(meera.paid, 0);
  const auto = await Payment.find({ isDemo: true, source: 'auto_screenshot' });
  assert.equal(auto.length, 4); // one per screenshot: Aanya, Kartik, Meera and Neha (Rohan pays cash on delivery)
  const verified = auto.filter((x) => x.status === 'confirmed');
  assert.equal(verified.length, 1); assert.ok(verified.every((x) => x.review?.by === 'Demo owner')); // only an explicit owner check, never the screenshot
  assert.ok(auto.filter((x) => x.status === 'pending').every((x) => !x.review));
});

test('6. repeated processing and re-seeding create no duplicate messages, pictures, orders or payments', { skip }, async () => {
  const snap = async () => ({ orders: await Order.countDocuments(), conv: await Conversation.countDocuments(), msgs: await Message.countDocuments(), pays: await Payment.countDocuments(), files: fs.readdirSync(proofDir).length });
  const before = await snap();
  assert.equal(before.msgs, TOTAL);
  for (const m of await Message.find({ isDemo: true, 'paymentScan.state': { $in: ['filed', 'review', 'duplicate'] } })) assert.equal((await processMessageImage(m._id)).state, 'skipped'); // already handled
  assert.equal(await refreshStaleDemo(), false); // a restart changes nothing
  assert.deepEqual(await snap(), before);
  const { created } = await reseedDemoOrders(new Date());
  await reseedDemoMessages(created, new Date());
  assert.deepEqual(await snap(), before); // re-seeding replaces rather than adds, and removes the old pictures from disk
  const ids = (await Message.find({ isDemo: true }).lean()).map((m) => m.externalId).sort();
  assert.equal(new Set(ids).size, TOTAL); assert.ok(ids.every((id) => /^demo-[a-z-]+-\d+$/.test(id))); // fixed ids, not random ones
  assert.equal((await ledger()).rows.find((r) => r.customerName === 'Kartik Singh').payments.length, 1);
});

test('7. an attachment that cannot be matched, or is not a payment, is handled safely', { skip }, async () => {
  const stray = await Conversation.create({ channel: 'whatsapp', contactId: '910000000099', customerName: 'Unknown Sender' });
  const png = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'assets', 'demo', 'pay-kabir-upi.png'));
  const { saveProof } = await import('../services/proofStore.js');
  const make = async (n, externalId) => {
    const a = await saveProof(Buffer.concat([png, Buffer.from([n])]), null); // a different image each time
    return Message.create({ conversation: stray._id, channel: 'whatsapp', externalId, messageType: 'image', attachment: { file: a.file, contentType: a.contentType, size: a.size, sha256: a.sha256 }, paymentScan: { state: 'processing', claimedAt: null } });
  };
  const reading = { amount: 777, transactionId: '999888777666', paidHoursAgo: 1, method: 'upi', recipient: null, confidence: 0.9, uncertainties: [] };
  const a = await make(1, 'stray-1');
  assert.equal((await processMessageImage(a._id, { read: async () => demoVision(reading) })).state, 'review'); // matched to nothing: kept for the owner
  const p = await Payment.findOne({ messageId: String(a._id) });
  assert.equal(p.order, null); assert.equal(p.status, 'pending'); assert.equal(p.match.state, 'unmatched');
  const led = await ledger();
  assert.ok(led.unassigned.some((x) => x.id === String(p._id) && x.displayStatus === 'pending_review'));
  assert.ok(led.rows.every((r) => r.payments.every((x) => x.id !== String(p._id)))); // not on anyone's order
  const b = await make(2, 'stray-2'); // an ordinary photo: no payment, and it is not shown as a reference image for any order
  assert.equal((await processMessageImage(b._id, { read: async () => ({ isPaymentScreenshot: false, amount: null }) })).state, 'not_payment');
  assert.equal(await Payment.countDocuments({ messageId: String(b._id) }), 0);
  const c = await make(3, 'stray-3'); // a failed reading: reported, nothing filed
  assert.equal((await processMessageImage(c._id, { read: async () => { throw new Error('The AI service could not be reached.'); } })).state, 'failed');
  assert.equal((await Message.findById(c._id)).paymentScan.state, 'failed');
  for (const name of ['Neha Sharma', 'Aanya Sharma']) assert.equal((await convOf(name)).spec.unsortedImages.length, 0);
});

test('the conversations read like real chats: the baker replies, in order, and only the customer\'s words become the specification', { skip }, async () => {
  for (const name of ['Neha Sharma', 'Aanya Sharma', 'Kartik Singh', 'Rohan Mehta', 'Meera Iyer']) {
    const c = await convOf(name);
    assert.ok(c.messages.some((m) => m.from === 'business') && c.messages.some((m) => m.from === 'customer'), name);
    assert.deepEqual(c.messages.map((m) => m.at), [...c.messages.map((m) => m.at)].sort(), name); // chronological
    assert.equal(c.messages[0].from, 'customer'); // the customer starts the enquiry
  }
  const neha = await convOf('Neha Sharma');
  assert.ok(neha.messages.some((m) => m.from === 'business' && /₹2,200/.test(m.text)) && neha.messages.some((m) => m.from === 'business' && /advance of ₹1,100/.test(m.text)));
  assert.ok(!JSON.stringify(neha.spec).includes('₹')); // the baker's price is not the customer's instruction
  const chat = (await get('/conversations')).json.items.find((c) => c.customerName === 'Neha Sharma');
  assert.equal(chat.unread, 1); // the baker's own messages are never unread
  assert.ok((await Message.find({ isDemo: true, direction: 'outbound' })).every((m) => m.readAt && !m.attachment));
});

test('each customer has their own payment story, all consistent with their order and none verified by a screenshot alone', { skip }, async () => {
  const rows = Object.fromEntries((await ledger()).rows.map((r) => [r.customerName, r]));
  const neha = rows['Neha Sharma']; // advance by screenshot (waiting for the owner) + the balance in cash on delivery
  assert.deepEqual(neha.payments.map((p) => [p.method, p.amount, p.displayStatus]).sort(), [['cod', 1100, 'awaiting_verification'], ['upi', 1100, 'awaiting_verification']].sort());
  assert.equal(neha.paid, 0);
  assert.deepEqual([rows['Aanya Sharma'].paid, rows['Aanya Sharma'].status, rows['Aanya Sharma'].payments[0].source], [1800, 'paid', 'auto_screenshot']);
  assert.deepEqual([rows['Rohan Mehta'].paid, rows['Rohan Mehta'].payments.map((p) => p.method)], [0, ['cod']]); // cash on delivery: no screenshot, nothing collected yet
  assert.deepEqual([rows['Kartik Singh'].paid, rows['Kartik Singh'].status], [0, 'verification_pending']);
  assert.deepEqual([rows['Meera Iyer'].paid, rows['Meera Iyer'].payments[0].displayStatus], [0, 'pending_review']);
  for (const name of Object.keys(rows)) assert.ok(rows[name].payments.every((p) => !p.proof || p.sourceMessage), name); // every screenshot points back to its message
});

const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };

test('owner actions: a detected payment is only Verified or Rejected by the owner, and a missing proof is shown as missing', { skip }, async () => {
  const led = await ledger();
  const kabir = led.rows.find((r) => r.customerName === 'Kartik Singh'); const pay = kabir.payments[0];
  assert.deepEqual([pay.status, pay.displayStatus], ['pending', 'awaiting_verification']); // read, matched, not verified
  assert.equal((await post(`/payments/${pay.id}/confirm`, { reviewer: 'Asha' })).status, 422); // must tick "I checked my account"
  const ok = await post(`/payments/${pay.id}/confirm`, { reviewer: 'Asha', acknowledged: true, amount: 720, transactionId: '412398765431' });
  assert.equal(ok.status, 200); assert.equal(ok.json.payment.displayStatus, 'verified'); assert.equal(ok.json.payment.review.by, 'Asha');
  assert.equal((await ledger()).rows.find((r) => r.customerName === 'Kartik Singh').paid, 720);

  const meera = led.rows.find((r) => r.customerName === 'Meera Iyer').payments[0]; // incomplete reading: the owner corrects the amount while verifying
  assert.equal(meera.displayStatus, 'pending_review');
  const rej = await post(`/payments/${meera.id}/reject`, { mode: 'reject', reviewer: 'Asha', note: 'Not in my account' });
  assert.equal(rej.json.payment.displayStatus, 'rejected');
  assert.equal((await ledger()).rows.find((r) => r.customerName === 'Meera Iyer').paid, 0);

  const o = (await (await fetch(base + '/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerName: 'No Proof Yet', item: 'Cake', quantity: 1, price: 900 }) })).json());
  const row = (await ledger()).rows.find((r) => r.orderId === o.id);
  assert.deepEqual([row.payments.length, row.status, row.paid], [0, 'due', 0]); // no proof received: the page offers to add it, nothing is assumed
  const manual = await post('/payments', { orderId: o.id, amount: 900, method: 'upi', transactionId: 'UTR555000111222' }); // added by hand: still pending
  assert.equal(manual.status, 201); assert.equal(manual.json.status, 'pending');
});

const callApi = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
const hm = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
const demoSnap = async () => JSON.stringify((await Order.find({ notes: /^\[DEMO\]/ }).sort({ customerName: 1 }).lean()).map((o) => [o.customerName, o.item, o.prepTimeMinutes, String(o.deadline), o.status, String(o.updatedAt)]));

test('What if? plans the demo orders from the real clock: the overdue order is the only conflict, and every order gets a realistic earliest deadline', { skip }, async () => {
  const before = await demoSnap();
  const ov = (await get('/planner/whatif?scope=commitment')).json;
  assert.equal(ov.cards.length, 5);
  assert.deepEqual(ov.cards.filter((c) => c.kind === 'deadline_passed').map((c) => c.customerName), ['Meera Iyer']); // the one promise that has already passed
  assert.equal(ov.conflicts, 1); assert.equal(ov.feasible, false);
  assert.ok(ov.cards.every((c) => c.ordered && Date.parse(c.ordered) < Date.parse(c.deadline))); // placed before it is due, on every card
  assert.ok(ov.cards.every((c) => c.earliest && Date.parse(c.earliest.deadline) > Date.parse(ov.now)));
  assert.equal(await demoSnap(), before); // nothing saved
});

test('What if? finds genuinely infeasible changes, never saves a simulation, and Apply changes the record and the Plan', { skip }, async () => {
  const before = await demoSnap();
  const ov = (await get('/planner/whatif?scope=commitment')).json;
  const neha = ov.cards.find((c) => c.customerName === 'Neha Sharma');
  const planDeadline = async () => (await get('/planner?days=30')).json.schedule.find((e) => e.orderId === neha.id).deadline;
  // A deadline one minute from now cannot be met by a 30-minute order that is not started.
  const tooTight = (await callApi('POST', '/planner/whatif/move', { scope: 'commitment', orderId: neha.id, deadline: new Date(Date.now() + 60000).toISOString() })).json;
  assert.deepEqual([tooTight.ok, tooTight.after.late.length > 0], [true, true]);
  // The earliest deadline the scheduler offers is possible: nothing becomes late because of it.
  const sim = (await callApi('POST', '/planner/whatif/move', { scope: 'commitment', orderId: neha.id, deadline: neha.earliest.deadline })).json;
  assert.deepEqual([sim.proposal.status, sim.after.late.length], ['unapplied', 0]);
  assert.equal(await demoSnap(), before); // previewing saved nothing
  assert.equal(await planDeadline(), neha.deadline);
  try {
    assert.equal((await callApi('PATCH', `/orders/${neha.id}`, { deadline: sim.proposal.to })).status, 200);
    assert.equal(await planDeadline(), sim.proposal.to); // the Plan follows the confirmed change
  } finally { await callApi('PATCH', `/orders/${neha.id}`, { deadline: neha.deadline }); }
});
