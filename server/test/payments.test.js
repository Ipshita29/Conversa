// Payments: the pure rules (no database), then the HTTP API against a throwaway mongod (skipped, loudly, if it is not installed).
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
import { summarize, orderPaymentStatus, findDuplicate, txnKey, validatePaymentInput, validateConfirm, validateReject, validateRefund, buildLedger } from '../services/paymentLogic.js';
import { parsePaymentText, validateVisionOutput } from '../services/paymentExtraction.js';
import { sniff } from '../services/proofStore.js';
import { buildDemoOrders, buildDemoPayments } from '../scripts/demo-data.js';

const order = (o = {}) => ({ id: 'o1', customerName: 'Asha', item: 'Cake', price: 1000, status: 'confirmed', paymentStatus: 'unverified', ...o });
const pay = (o = {}) => ({ id: `p${Math.random()}`, orderId: 'o1', kind: 'payment', amount: 100, method: 'upi', status: 'confirmed', transactionId: null, ...o });

// ---- Pure rules ---------------------------------------------------------------------------------------------------------
test('partial payments and instalments: balance is the total minus CONFIRMED payments only', () => {
  const s = summarize(order(), [pay({ amount: 400 }), pay({ amount: 100 })]);
  assert.deepEqual([s.paid, s.balance, s.status], [500, 500, 'partial']);
  const full = summarize(order(), [pay({ amount: 400 }), pay({ amount: 600 })]);
  assert.deepEqual([full.paid, full.balance, full.status], [1000, 0, 'paid']);
});

test('a pending claim or a rejected one is never counted as received', () => {
  const s = summarize(order(), [pay({ amount: 1000, status: 'pending' }), pay({ amount: 1000, status: 'rejected' })]);
  assert.equal(s.paid, 0); assert.equal(s.balance, 1000); assert.equal(s.pending, 1000); assert.equal(s.status, 'verification_pending');
});

test('COD is due on delivery and not received until collection is confirmed', () => {
  const cod = pay({ amount: 1000, method: 'cod', status: 'pending' });
  const s = summarize(order(), [cod]);
  assert.deepEqual([s.paid, s.codDue, s.balance, s.status], [0, 1000, 1000, 'cod']);
  const done = summarize(order(), [{ ...cod, status: 'confirmed' }]);
  assert.deepEqual([done.paid, done.codDue, done.status], [1000, 0, 'paid']);
});

test('refunds reduce what counts as received; amounts are not double counted', () => {
  const orig = pay({ id: 'a', amount: 1000 });
  const s = summarize(order(), [orig, pay({ kind: 'refund', refundOf: 'a', amount: 300 })]);
  assert.deepEqual([s.paid, s.refunded, s.balance, s.status], [700, 300, 300, 'partial']);
  const cents = summarize(order({ price: 0.3 }), [pay({ amount: 0.1 }), pay({ amount: 0.2 })]);
  assert.equal(cents.paid, 0.3); assert.equal(cents.status, 'paid'); // 0.1 + 0.2 must not become 0.30000000000000004
});

test('order payment status follows the records and never the production status', () => {
  const o = order({ status: 'in_progress' });
  assert.equal(orderPaymentStatus(o, []), 'unverified'); // no records: the owner's own setting is kept
  assert.equal(orderPaymentStatus(order({ paymentStatus: 'verified' }), []), 'verified');
  assert.equal(orderPaymentStatus(o, [pay({ status: 'pending' })]), 'pending');
  assert.equal(orderPaymentStatus(o, [pay({ amount: 200 })]), 'partial');
  assert.equal(orderPaymentStatus(o, [pay({ amount: 1000 })]), 'verified');
  assert.equal(orderPaymentStatus(o, [pay({ status: 'rejected' })]), 'rejected');
});

test('duplicate transactions are caught however they are typed, and a rejected record frees the ID', () => {
  assert.equal(txnKey(' utr 4123 9876 5431 '), 'UTR412398765431');
  const a = pay({ id: 'a', transactionId: 'UTR412398765431' });
  assert.equal(findDuplicate([a], txnKey('utr 4123 9876 5431'))?.id, 'a');
  assert.equal(findDuplicate([{ ...a, status: 'rejected' }], txnKey('UTR412398765431')), null);
  assert.equal(findDuplicate([a], txnKey('UTR412398765431'), 'a'), null);
  assert.equal(findDuplicate([a], null), null);
});

test('manual entry validation: amounts, method, reference, date, reviewer', () => {
  const ok = validatePaymentInput({ orderId: 'o1', amount: 250.5, method: 'upi', transactionId: 'UTR412398765431', paidAt: '2026-10-01T10:00:00+05:30' });
  assert.deepEqual(ok.details, []); assert.equal(ok.value.confirmed, false);
  const bad = validatePaymentInput({ orderId: 'o1', amount: -5, method: 'crypto', transactionId: '!', paidAt: new Date(Date.now() + 864e5).toISOString(), evil: 1 });
  assert.deepEqual(bad.details.map((d) => d.field).sort(), ['amount', 'evil', 'method', 'paidAt', 'transactionId']);
  assert.ok(validatePaymentInput({ orderId: 'o1', amount: 1.234, method: 'upi' }).details.some((d) => d.field === 'amount'));
  assert.ok(validatePaymentInput({ orderId: 'o1', amount: 5, method: 'cash', transactionId: 'ABCD1234' }).details.some((d) => d.field === 'transactionId'));
  assert.ok(validatePaymentInput({ orderId: 'o1', amount: 5, method: 'upi', confirmed: true }).details.some((d) => d.field === 'reviewer'));
});

test('confirming needs an explicit check, a reviewer, a reference, and cannot exceed the balance', () => {
  const p = pay({ status: 'pending', amount: 600, transactionId: null });
  const s = summarize(order(), []);
  const fields = (b) => { try { validateConfirm(b, p, s); return []; } catch (e) { return e.details.map((d) => d.field); } };
  assert.deepEqual(fields({}).sort(), ['acknowledged', 'reviewer', 'transactionId']);
  assert.deepEqual(fields({ acknowledged: true, reviewer: 'Asha', noReference: true }), []);
  assert.throws(() => validateConfirm({ acknowledged: true, reviewer: 'Asha', amount: 1500, transactionId: 'ABCD1234' }, p, s), (e) => e.code === 'EXCEEDS_BALANCE');
  assert.throws(() => validateConfirm({ acknowledged: true, reviewer: 'A', transactionId: 'ABCD1234' }, { ...p, status: 'confirmed' }, s), (e) => e.status === 409);
  const v = validateConfirm({ acknowledged: true, reviewer: ' Asha ', amount: 550, transactionId: 'ABCD1234' }, p, s);
  assert.deepEqual([v.amount, v.reviewer], [550, 'Asha']); // the owner may confirm a different amount than was claimed
  assert.throws(() => validateReject({ mode: 'reject', reviewer: 'A' }), (e) => e.details.some((d) => d.field === 'note'));
  assert.throws(() => validateRefund({ amount: 900, reviewer: 'A', reason: 'x' }, pay({ id: 'a', amount: 500 }), []), (e) => e.details.some((d) => d.field === 'amount'));
});

test('text extraction: reads amount, reference, method; flags what is missing; never certain', () => {
  const x = parsePaymentText('Hi, paid Rs 3,200 via GPay. UPI Ref No: 412398765431');
  assert.deepEqual([x.isPayment, x.amount, x.transactionId, x.method, x.needsReview], [true, 3200, '412398765431', 'upi', true]);
  assert.ok(x.confidence > 0.5 && x.confidence <= 0.9);
  const thin = parsePaymentText('I have transferred ₹500 just now');
  assert.equal(thin.amount, 500); assert.ok(thin.issues.some((i) => /transaction/i.test(i)));
  assert.equal(parsePaymentText('Can I have the cake by 5pm tomorrow?').isPayment, false);
  assert.equal(parsePaymentText('Paid ₹500 and ₹800').issues.some((i) => /More than one amount/.test(i)), true);
});

test('vision output is validated strictly and capped in confidence', () => {
  const ok = validateVisionOutput({ isPaymentScreenshot: true, amount: '1,800', transactionId: ' 123456789012 ', method: 'upi', status: 'success', confidence: 1, paidAt: '2026-10-01T10:00:00+05:30', uncertainties: ['blur'] });
  assert.deepEqual([ok.amount, ok.transactionId, ok.confidence], [1800, '123456789012', 0.9]);
  assert.throws(() => validateVisionOutput({ amount: -4 }));
  assert.throws(() => validateVisionOutput({ method: 'paypal' }));
  assert.throws(() => validateVisionOutput('nope'));
});

test('ledger KPIs come from the records', () => {
  const orders = [order({ id: 'o1', price: 1000 }), order({ id: 'o2', price: 500 }), order({ id: 'o3', price: 800, status: 'cancelled' })];
  const { kpis, rows } = buildLedger(orders, [pay({ orderId: 'o1', amount: 400 }), pay({ orderId: 'o2', amount: 500, status: 'pending' }), pay({ orderId: 'o2', id: 'c', amount: 500, method: 'cod', status: 'pending' })]);
  assert.deepEqual([kpis.totalReceived, kpis.outstanding, kpis.partiallyPaid, kpis.toVerify], [400, 1100, 1, 1]);
  assert.equal(rows.find((r) => r.orderId === 'o2').status, 'verification_pending');
});

test('demo payments: one story each, flagged demo, nothing verified by a bank', () => {
  const orders = buildDemoOrders({ timezone: 'Asia/Kolkata', workingDays: [1, 2, 3, 4, 5, 6], workStart: '09:00', workEnd: '18:00' }, new Date()).map((o, i) => ({ ...o, id: `d${i}` }));
  const payments = buildDemoPayments(orders).map((p, i) => ({ ...p, id: `dp${i}` }));
  const { rows } = buildLedger(orders, payments);
  const st = Object.fromEntries(rows.map((r) => [r.customerName, r.status]));
  assert.deepEqual(st, { 'Aanya Sharma': 'paid', 'Rohan Mehta': 'partial', 'Meera Iyer': 'due', 'Neha Sharma': 'cod', 'Kabir Singh': 'verification_pending' });
  assert.ok(payments.every((p) => p.isDemo));
  const kabir = payments.find((p) => p.source === 'chat_screenshot');
  assert.equal(kabir.status, 'pending'); assert.equal(rows.find((r) => r.customerName === 'Kabir Singh').paid, 0);
  assert.equal(orders.find((o) => o.customerName === 'Rohan Mehta').price, 2700);
});

test('image type is decided from the bytes, not the label', () => {
  assert.equal(sniff(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), Buffer.alloc(16)]))?.type, 'image/png');
  assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(sniff(Buffer.from('<html><script>alert(1)</script></html>')), null);
});

// ---- HTTP API ---------------------------------------------------------------------------------------------------------
const hasMongod = spawnSync('mongod', ['--version']).status === 0;
const skip = hasMongod ? false : 'mongod not installed: integration tests skipped';
let proc; let server; let base; let dir; let proofDir; const realFetch = globalThis.fetch;

before(async () => {
  if (!hasMongod) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversa-pay-'));
  proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversa-proof-'));
  config.payments.proofDir = proofDir;
  const port = 28000 + Math.floor(Math.random() * 1000);
  proc = spawn('mongod', ['--dbpath', dir, '--port', String(port), '--bind_ip', '127.0.0.1', '--nounixsocket'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { if (await connectDb(`mongodb://127.0.0.1:${port}/conversa_pay_test`)) break; await new Promise((r) => setTimeout(r, 500)); }
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
  config.groq.apiKey = '';
  await mongoose.model('Payment').init(); // build the unique index before the first write
});
after(async () => { globalThis.fetch = realFetch; server?.close(); await mongoose.disconnect(); proc?.kill(); for (const d of [dir, proofDir]) if (d) fs.rmSync(d, { recursive: true, force: true }); });

const call = async (method, p, body, headers = {}) => {
  const isBuf = Buffer.isBuffer(body);
  const res = await fetch(base + p, { method, headers: body === undefined ? headers : isBuf ? headers : { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body) });
  const ct = res.headers.get('content-type') ?? '';
  return { status: res.status, headers: res.headers, json: ct.includes('json') ? await res.json() : null, bytes: ct.startsWith('image/') ? Buffer.from(await res.arrayBuffer()) : null };
};
const img = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), Buffer.alloc(40, n)]); // distinct bytes = a distinct screenshot
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), Buffer.alloc(40, 7)]);
const newOrder = async (extra = {}) => (await call('POST', '/orders', { customerName: 'Pay Test', item: 'Cake', quantity: 1, price: 1000, status: 'in_progress', ...extra })).json;
const orderOf = async (id) => (await call('GET', `/orders/${id}`)).json;
const OWNER = { acknowledged: true, reviewer: 'Asha' };

test('a recorded payment starts as Verification pending and never touches production status', { skip }, async () => {
  const o = await newOrder();
  const r = await call('POST', '/payments', { orderId: o.id, amount: 1000, method: 'upi', transactionId: 'UTR100000000001' });
  assert.equal(r.status, 201); assert.equal(r.json.status, 'pending');
  const after = await orderOf(o.id);
  assert.equal(after.status, 'in_progress'); assert.equal(after.paymentStatus, 'pending');
  const row = (await call('GET', '/payments')).json.rows.find((x) => x.orderId === o.id);
  assert.deepEqual([row.paid, row.balance, row.status], [0, 1000, 'verification_pending']);
});

test('confirm: partial then final instalment; duplicates, overpayment and double confirmation are refused', { skip }, async () => {
  const o = await newOrder();
  const a = (await call('POST', '/payments', { orderId: o.id, amount: 400, method: 'bank_transfer', transactionId: 'NEFT200000000002' })).json;
  const noAck = await call('POST', `/payments/${a.id}/confirm`, { reviewer: 'Asha' });
  assert.equal(noAck.status, 422);
  const c1 = await call('POST', `/payments/${a.id}/confirm`, OWNER);
  assert.equal(c1.status, 200); assert.equal(c1.json.payment.status, 'confirmed'); assert.equal(c1.json.payment.review.by, 'Asha'); assert.ok(c1.json.payment.review.at);
  assert.deepEqual([c1.json.summary.paid, c1.json.summary.balance, c1.json.summary.status], [400, 600, 'partial']);
  assert.equal((await orderOf(o.id)).paymentStatus, 'partial');
  assert.equal((await call('POST', `/payments/${a.id}/confirm`, OWNER)).status, 409);

  const dup = await call('POST', '/payments', { orderId: o.id, amount: 100, method: 'upi', transactionId: 'neft 2000 0000 0002' });
  assert.equal(dup.status, 409); assert.equal(dup.json.error.code, 'DUPLICATE_TRANSACTION');
  const over = await call('POST', '/payments', { orderId: o.id, amount: 700, method: 'upi', transactionId: 'UPI300000000003', confirmed: true, reviewer: 'Asha' });
  assert.equal(over.status, 422); assert.equal(over.json.error.code, 'EXCEEDS_BALANCE');

  const b = await call('POST', '/payments', { orderId: o.id, amount: 600, method: 'upi', transactionId: 'UPI300000000003', confirmed: true, reviewer: 'Asha' });
  assert.equal(b.status, 201); assert.equal(b.json.status, 'confirmed');
  const done = await orderOf(o.id);
  assert.equal(done.paymentStatus, 'verified'); assert.equal(done.status, 'in_progress');
});

test('rejecting frees the transaction ID, and counts for nothing', { skip }, async () => {
  const o = await newOrder();
  const a = (await call('POST', '/payments', { orderId: o.id, amount: 1000, method: 'upi', transactionId: 'UPI400000000004' })).json;
  assert.equal((await call('POST', `/payments/${a.id}/reject`, { mode: 'reject', reviewer: 'Asha' })).status, 422); // a reason is required
  const rej = await call('POST', `/payments/${a.id}/reject`, { mode: 'reject', reviewer: 'Asha', note: 'Not in my account' });
  assert.equal(rej.json.payment.status, 'rejected'); assert.equal(rej.json.summary.paid, 0);
  assert.equal((await orderOf(o.id)).paymentStatus, 'rejected');
  assert.equal((await call('POST', '/payments', { orderId: o.id, amount: 1000, method: 'upi', transactionId: 'UPI400000000004' })).status, 201);
  const flag = (await call('POST', '/payments', { orderId: o.id, amount: 50, method: 'upi', transactionId: 'UPI400000000005' })).json;
  const nr = await call('POST', `/payments/${flag.id}/reject`, { mode: 'needs_review', reviewer: 'Asha', note: 'Amount looks wrong' });
  assert.equal(nr.json.payment.status, 'pending'); assert.equal(nr.json.payment.extraction.needsReview, true);
});

test('COD stays due until the owner confirms collection', { skip }, async () => {
  const o = await newOrder({ price: 800 });
  const cod = (await call('POST', '/payments', { orderId: o.id, amount: 800, method: 'cod' })).json;
  let row = (await call('GET', '/payments')).json.rows.find((x) => x.orderId === o.id);
  assert.deepEqual([row.status, row.paid, row.codDue, row.balance], ['cod', 0, 800, 800]);
  assert.equal((await orderOf(o.id)).paymentStatus, 'unverified');
  await call('POST', `/payments/${cod.id}/confirm`, OWNER);
  row = (await call('GET', '/payments')).json.rows.find((x) => x.orderId === o.id);
  assert.deepEqual([row.status, row.paid, row.codDue], ['paid', 800, 0]);
});

test('refunds are a separate confirmed record and reopen the balance', { skip }, async () => {
  const o = await newOrder();
  const p = (await call('POST', '/payments', { orderId: o.id, amount: 1000, method: 'cash', confirmed: true, reviewer: 'Asha' })).json;
  assert.equal((await orderOf(o.id)).paymentStatus, 'verified');
  assert.equal((await call('POST', `/payments/${p.id}/refund`, { amount: 1200, reviewer: 'Asha', reason: 'x' })).status, 422);
  const r = await call('POST', `/payments/${p.id}/refund`, { amount: 300, reviewer: 'Asha', reason: 'Item cancelled' });
  assert.equal(r.status, 201); assert.deepEqual([r.json.summary.paid, r.json.summary.balance, r.json.summary.status], [700, 300, 'partial']);
  assert.equal((await orderOf(o.id)).paymentStatus, 'partial');
});

test('proof upload: type checked from bytes, served only through the API with a fixed type', { skip }, async () => {
  const o = await newOrder();
  const p = (await call('POST', '/payments', { orderId: o.id, amount: 100, method: 'upi', transactionId: 'UPI500000000006' })).json;
  const bad = await call('POST', `/payments/${p.id}/proof`, Buffer.from('<html><script>alert(1)</script></html>'), { 'Content-Type': 'image/png' });
  assert.equal(bad.status, 415);
  const ok = await call('POST', `/payments/${p.id}/proof`, png(), { 'Content-Type': 'image/png', 'X-File-Name': 'shot.png' });
  assert.equal(ok.status, 201); assert.equal(ok.json.proof.contentType, 'image/png');
  const got = await call('GET', `/payments/${p.id}/proof`);
  assert.equal(got.status, 200); assert.equal(got.headers.get('content-type'), 'image/png'); assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(got.bytes, png());
  assert.ok(fs.readdirSync(proofDir).every((f) => /^[a-f0-9]{32}\.png$/.test(f))); // random names; the customer's file name is never used on disk
  assert.equal((await call('POST', `/payments/${p.id}/proof`, Buffer.from('x'), { 'Content-Type': 'text/plain' })).status, 415);
});

test('chat text becomes a pending record linked to the chat\'s order; non-payment text creates nothing', { skip }, async () => {
  const o = await newOrder();
  const r = await call('POST', '/payments/extract', { message: 'Paid ₹1000 via GPay, UPI Ref No: 612398765431', orderId: o.id });
  assert.equal(r.status, 201); assert.equal(r.json.payment.status, 'pending'); assert.equal(r.json.payment.source, 'chat_text');
  assert.equal(r.json.payment.extraction.needsReview, true); assert.equal(r.json.payment.transactionId, '612398765431');
  assert.equal((await orderOf(o.id)).paymentStatus, 'pending'); // a claim: the order is NOT paid
  const again = await call('POST', '/payments/extract', { message: 'Paid ₹1000 via GPay, UPI Ref No: 612398765431', orderId: o.id });
  assert.equal(again.status, 409); // the same screenshot text twice is the same transaction
  const no = await call('POST', '/payments/extract', { message: 'Can you make it taller?', orderId: o.id });
  assert.equal(no.status, 200); assert.equal(no.json.payment, null);
  const unlinked = await call('POST', '/payments/extract', { message: 'Paid ₹500 UPI Ref 712398765431' });
  assert.equal(unlinked.json.payment, null); assert.match(unlinked.json.reason, /Link this chat/);
});

test('failed screenshot extraction saves nothing: no payment, no stored file', { skip }, async () => {
  const o = await newOrder();
  const before = fs.readdirSync(proofDir).length;
  const unconfigured = await call('POST', `/payments/extract-image?orderId=${o.id}`, img(61), { 'Content-Type': 'image/png' });
  assert.equal(unconfigured.status, 503); assert.equal(unconfigured.json.error.code, 'AI_UNAVAILABLE');

  config.groq.apiKey = 'test-key';
  globalThis.fetch = async (url, init) => (String(url).includes('groq.com')
    ? new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ isPaymentScreenshot: true, amount: null, confidence: 0.2 }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    : realFetch(url, init));
  try {
    const failed = await call('POST', `/payments/extract-image?orderId=${o.id}`, img(62), { 'Content-Type': 'image/png' });
    assert.equal(failed.status, 422); assert.equal(failed.json.error.code, 'EXTRACTION_FAILED');

    globalThis.fetch = async (url, init) => (String(url).includes('groq.com')
      ? new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ isPaymentScreenshot: true, amount: 1000, transactionId: '812398765431', method: 'upi', status: 'success', confidence: 0.95, uncertainties: ['Recipient hidden'] }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      : realFetch(url, init));
    const ok = await call('POST', `/payments/extract-image?orderId=${o.id}`, img(63), { 'Content-Type': 'image/png' });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.payment.status, 'pending'); assert.equal(ok.json.payment.source, 'chat_screenshot');
    assert.equal(ok.json.payment.extraction.method, 'vision'); assert.ok(ok.json.payment.extraction.confidence <= 0.9); assert.ok(ok.json.payment.proof);
    assert.ok(ok.json.payment.extraction.issues.includes('Recipient hidden'));
    assert.equal((await orderOf(o.id)).paymentStatus, 'pending'); // a screenshot never marks an order paid
    assert.equal(fs.readdirSync(proofDir).length, before + 1); // only the successful read stored a file
  } finally { globalThis.fetch = realFetch; config.groq.apiKey = ''; }
});

test('payment-looking webhook text in a linked chat files a pending record', { skip }, async () => {
  const { ingest } = await import('../services/messageService.js');
  const Conversation = mongoose.model('Conversation');
  const o = await newOrder();
  await Conversation.create({ channel: 'whatsapp', contactId: 'pay-test-1', customerName: 'Pay Test', orderId: o.id });
  const res = await ingest([{ channel: 'whatsapp', contactId: 'pay-test-1', contactName: 'Pay Test', externalId: 'wamid.pay1', text: 'Done! Paid Rs 1000 by UPI, UTR 912398765431', messageType: 'text', receivedAt: new Date() }]);
  assert.equal(res.stored, 1);
  const row = (await call('GET', '/payments')).json.rows.find((x) => x.orderId === o.id);
  assert.equal(row.payments.length, 1); assert.equal(row.payments[0].status, 'pending'); assert.equal(row.paid, 0);
});

test('read-image only reads: nothing is saved or stored, and the same limits and failures apply', { skip }, async () => {
  const before = fs.readdirSync(proofDir).length;
  const rows = async () => (await call('GET', '/payments')).json.rows.reduce((n, r) => n + r.payments.length, 0);
  const count = await rows();
  assert.equal((await call('POST', '/payments/read-image', img(71), { 'Content-Type': 'image/png' })).json.error.code, 'AI_UNAVAILABLE'); // no key
  assert.equal((await call('POST', '/payments/read-image', Buffer.from('<svg/>'), { 'Content-Type': 'image/png' })).status, 415);
  config.groq.apiKey = 'test-key';
  const reply = (o) => async (url, init) => (String(url).includes('groq.com') ? new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(o) } }] }), { status: 200, headers: { 'content-type': 'application/json' } }) : realFetch(url, init));
  try {
    globalThis.fetch = reply({ isPaymentScreenshot: true, amount: null });
    assert.equal((await call('POST', '/payments/read-image', img(72), { 'Content-Type': 'image/png' })).json.error.code, 'EXTRACTION_FAILED');
    globalThis.fetch = reply({ isPaymentScreenshot: true, amount: 3200, transactionId: '412398765431', method: 'upi', status: 'success', confidence: 0.97, paidAt: '2026-10-29T11:42:00+05:30', uncertainties: [] });
    const ok = await call('POST', '/payments/read-image', img(73), { 'Content-Type': 'image/png' });
    assert.equal(ok.status, 200); const x = ok.json.extraction;
    assert.deepEqual([x.amount, x.transactionId, x.paymentMethod], [3200, '412398765431', 'upi']);
    assert.deepEqual(Object.keys(x).sort(), ['amount', 'extractionConfidence', 'model', 'paymentDate', 'paymentMethod', 'recipientDetails', 'transactionId', 'warnings']);
    assert.ok(x.extractionConfidence <= 0.9); assert.equal(x.model, config.groq.visionModel); assert.equal(ok.json.duplicate, null); assert.match(ok.json.proofHash, /^[a-f0-9]{64}$/);
  } finally { globalThis.fetch = realFetch; config.groq.apiKey = ''; }
  assert.equal(fs.readdirSync(proofDir).length, before); assert.equal(await rows(), count);
});


// ---- Unified screenshot workflow ------------------------------------------------------------------------------------------
const stubGroq = (o) => { globalThis.fetch = async (url, init) => (String(url).includes('groq.com') ? new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(o) } }] }), { status: 200, headers: { 'content-type': 'application/json' } }) : realFetch(url, init)); config.groq.apiKey = 'test-key'; };
const unstub = () => { globalThis.fetch = realFetch; config.groq.apiKey = ''; };
const READ = (o = {}) => ({ isPaymentScreenshot: true, amount: 1500, transactionId: 'UTR700000000001', method: 'upi', status: 'success', confidence: 0.9, paidAt: '2026-10-29T11:42:00+05:30', uncertainties: [], ...o });
const PNG = { 'Content-Type': 'image/png' };
const wait = async () => {};

test('the same screenshot cannot be filed twice, whichever entry point it comes through', { skip }, async () => {
  const a = await newOrder({ price: 3000 }); const b = await newOrder({ price: 3000 });
  stubGroq(READ({ transactionId: 'UTR700000000010' }));
  try {
    const first = await call('POST', `/payments/extract-image?orderId=${a.id}`, img(11), PNG);
    assert.equal(first.status, 201); assert.equal(first.json.payment.status, 'pending');
    const again = await call('POST', `/payments/extract-image?orderId=${b.id}`, img(11), PNG); // same image, even for another order
    assert.equal(again.status, 409); assert.equal(again.json.error.code, 'DUPLICATE_SCREENSHOT');
    const peek = await call('POST', '/payments/read-image', img(11), PNG); // the Payments modal is told before the owner fills anything in
    assert.equal(peek.json.duplicate.id, first.json.payment.id); assert.equal(peek.json.duplicate.status, 'pending');
    const manual = (await call('POST', '/payments', { orderId: b.id, amount: 100, method: 'upi', transactionId: 'UPI700000000011' })).json;
    const attach = await call('POST', `/payments/${manual.id}/proof`, img(11), PNG);
    assert.equal(attach.status, 409); assert.equal(attach.json.error.code, 'DUPLICATE_SCREENSHOT');
    assert.equal((await call('POST', `/payments/${manual.id}/proof`, img(12), PNG)).status, 201); // a different image is fine
    // a rejected record frees its screenshot for a corrected entry
    await call('POST', `/payments/${first.json.payment.id}/reject`, { mode: 'reject', reviewer: 'Asha', note: 'Wrong order' });
    assert.equal((await call('POST', `/payments/extract-image?orderId=${b.id}`, img(11), PNG)).status, 201);
  } finally { unstub(); }
});

test('Payments modal path: owner-corrected reading is saved as a pending screenshot upload and can be confirmed', { skip }, async () => {
  const o = await newOrder({ price: 2000 });
  stubGroq(READ({ amount: 2500, transactionId: 'UTR700000000020', confidence: 0.99 }));
  try {
    const read = await call('POST', '/payments/read-image', img(21), PNG);
    assert.equal(read.json.extraction.amount, 2500); // the model read 2,500...
    const x = read.json.extraction;
    const saved = await call('POST', '/payments', { orderId: o.id, amount: 2000, method: 'upi', transactionId: 'UTR700000000020', extraction: { extractionConfidence: 0.99, warnings: ['Amount corrected by owner'], recipientDetails: 'Sweet Crumbs', edited: true, model: x.model }, status: 'confirmed' });
    assert.equal(saved.status, 422); // ...and a client cannot sneak a status in
    const ok = await call('POST', '/payments', { orderId: o.id, amount: 2000, method: 'upi', transactionId: 'UTR700000000020', extraction: { extractionConfidence: 0.99, warnings: ['Amount corrected by owner'], recipientDetails: 'Sweet Crumbs', edited: true, model: x.model } });
    assert.equal(ok.status, 201); assert.equal(ok.json.status, 'pending'); assert.equal(ok.json.source, 'screenshot_upload');
    assert.equal(ok.json.extraction.confidence, 0.9); assert.equal(ok.json.extraction.edited, true); assert.equal(ok.json.extraction.needsReview, true); // capped, never certain
    assert.equal((await call('POST', `/payments/${ok.json.id}/proof`, img(21), PNG)).status, 201);
    assert.equal((await orderOf(o.id)).paymentStatus, 'pending'); // a screenshot is not money
    const c = await call('POST', `/payments/${ok.json.id}/confirm`, { ...OWNER, amount: 2000 });
    assert.deepEqual([c.json.summary.paid, c.json.summary.balance, c.json.summary.status], [2000, 0, 'paid']);
  } finally { unstub(); }
});

test('unclear images, missing references and failed reads: nothing is saved, manual entry stays possible', { skip }, async () => {
  const o = await newOrder();
  const before = fs.readdirSync(proofDir).length;
  stubGroq({ isPaymentScreenshot: false, amount: null, confidence: 0.1 });
  try {
    for (const path of ['/payments/read-image', `/payments/extract-image?orderId=${o.id}`]) {
      const r = await call('POST', path, img(31), PNG);
      assert.equal(r.status, 422); assert.equal(r.json.error.code, 'EXTRACTION_FAILED'); assert.match(r.json.error.message, /by hand/);
    }
    stubGroq(READ({ transactionId: null, paidAt: null }));
    const r = await call('POST', `/payments/extract-image?orderId=${o.id}`, img(32), PNG);
    assert.equal(r.status, 201); assert.equal(r.json.payment.transactionId, null);
    assert.ok(r.json.extraction.warnings.includes('No transaction ID visible.')); assert.ok(r.json.extraction.warnings.includes('No payment date and time visible.'));
    assert.equal((await call('POST', `/payments/${r.json.payment.id}/confirm`, OWNER)).status, 422); // cannot confirm without a reference unless the owner says there is none
    assert.equal((await call('POST', `/payments/${r.json.payment.id}/confirm`, { ...OWNER, noReference: true, amount: 400 })).status, 200); // owner corrects the amount
  } finally { unstub(); }
  assert.equal(fs.readdirSync(proofDir).length, before + 1);
});

test('Inbox path: a picture in a chat is shown, read once, filed as pending on the chat\'s order, then confirmed', { skip }, async () => {
  const Conversation = mongoose.model('Conversation');
  const o = await newOrder({ price: 1500 });
  const conv = await Conversation.create({ channel: 'whatsapp', contactId: 'shot-chat-1', customerName: 'Shot Test', orderId: o.id });
  const noOrder = await Conversation.create({ channel: 'whatsapp', contactId: 'shot-chat-2', customerName: 'No Order' });

  assert.equal((await call('POST', `/conversations/${conv.id}/attachments`, Buffer.from('<svg/>'), PNG)).status, 415);
  const up = await call('POST', `/conversations/${conv.id}/attachments`, img(41), { ...PNG, 'X-File-Name': 'gpay.png' });
  assert.equal(up.status, 201); assert.ok(up.json.attachment.url); assert.equal(up.json.payment, null);
  const shown = await call('GET', `/conversations/${conv.id}/messages/${up.json.id}/attachment`);
  assert.equal(shown.status, 200); assert.equal(shown.headers.get('content-type'), 'image/png'); assert.deepEqual(shown.bytes, img(41));
  assert.equal((await call('GET', `/conversations/${conv.id}/messages/${'0'.repeat(24)}/attachment`)).status, 404);

  stubGroq(READ({ transactionId: 'UTR700000000040', amount: 1500 }));
  try {
    const r = await call('POST', `/conversations/${conv.id}/messages/${up.json.id}/extract-payment`);
    assert.equal(r.status, 201); assert.equal(r.json.payment.status, 'pending'); assert.equal(r.json.payment.source, 'chat_screenshot'); assert.equal(r.json.payment.orderId, o.id);
    assert.equal(r.json.payment.conversationId, String(conv.id)); assert.equal(r.json.payment.messageId, up.json.id); assert.ok(r.json.payment.proof);
    assert.equal(r.json.extraction.paymentMethod, 'upi');
    const again = await call('POST', `/conversations/${conv.id}/messages/${up.json.id}/extract-payment`);
    assert.equal(again.status, 200); assert.equal(again.json.existing, true); assert.equal(again.json.payment.id, r.json.payment.id); // no second record
    const row = (await call('GET', '/payments')).json.rows.find((x) => x.orderId === o.id);
    assert.equal(row.payments.length, 1); assert.equal(row.paid, 0); assert.equal(row.status, 'verification_pending');
    const chat = (await call('GET', '/conversations')).json.items.find((c) => c.id === String(conv.id));
    const msg = chat.messages.find((m) => m.id === up.json.id);
    assert.equal(msg.payment.status, 'pending'); assert.equal(msg.payment.amount, 1500); assert.ok(msg.attachment.url);
    assert.equal((await orderOf(o.id)).status, 'in_progress'); // production status untouched
    const c = await call('POST', `/payments/${r.json.payment.id}/confirm`, OWNER);
    assert.equal(c.json.summary.status, 'paid'); assert.equal((await orderOf(o.id)).paymentStatus, 'verified');

    const up2 = await call('POST', `/conversations/${noOrder.id}/attachments`, img(42), PNG);
    const bad = await call('POST', `/conversations/${noOrder.id}/messages/${up2.json.id}/extract-payment`);
    assert.equal(bad.status, 409); assert.match(bad.json.error.message, /Link this chat/);
  } finally { unstub(); }
});

test('WhatsApp image messages are downloaded from Meta only, kept, and never lose the message on failure', { skip }, async () => {
  const { ingest } = await import('../services/messageService.js');
  const { downloadMedia } = await import('../services/integrations/whatsappService.js');
  config.meta.whatsapp.accessToken = 'wa-token';
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (!u.includes('graph.facebook.com') && !u.includes('lookaside.fbsbx.com')) return realFetch(url, init);
    calls.push(u);
    if (u.includes('graph.facebook.com')) return new Response(JSON.stringify({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(img(51), { status: 200 });
  };
  try {
    const when = new Date();
    const r = await ingest([{ channel: 'whatsapp', contactId: 'media-1', contactName: 'Media Test', externalId: 'wamid.img1', messageType: 'image', text: 'paid!', mediaId: 'MEDIA123', receivedAt: when }]);
    assert.equal(r.stored, 1);
    const chat = (await call('GET', '/conversations')).json.items.find((c) => c.customerName === 'Media Test');
    assert.ok(chat.messages[0].attachment.url); assert.equal(chat.messages[0].text, 'paid!');
    assert.ok(calls.some((u) => u.includes('lookaside.fbsbx.com'))); // the picture came from Meta's host

    globalThis.fetch = async (url, init) => (String(url).includes('graph.facebook.com') ? new Response(JSON.stringify({ url: 'https://evil.example.com/x.png' }), { status: 200, headers: { 'content-type': 'application/json' } }) : realFetch(url, init));
    assert.equal(await downloadMedia('MEDIA999'), null); // a link that is not Meta's is never fetched, so the token is never sent there
    const r2 = await ingest([{ channel: 'whatsapp', contactId: 'media-1', externalId: 'wamid.img2', messageType: 'image', text: null, mediaId: 'MEDIA999', receivedAt: new Date() }]);
    assert.equal(r2.stored, 1); // the message is kept without a picture
  } finally { globalThis.fetch = realFetch; config.meta.whatsapp.accessToken = ''; }
});

// ---- CORS (no database needed) --------------------------------------------------------------------------------------------
test('CORS: both local Vite origins pass preflight with the headers uploads need; unknown origins get no Allow-Origin', async () => {
  const srv = await new Promise((r) => { const s = createApp().listen(0, () => r(s)); });
  try {
    const url = `http://127.0.0.1:${srv.address().port}/api/payments/read-image`;
    const pre = (origin) => fetch(url, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-file-name,authorization' } });
    for (const origin of ['http://localhost:5173', 'http://localhost:5174']) {
      const r = await pre(origin);
      assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), origin);
      assert.match(r.headers.get('access-control-allow-headers'), /content-type/i); assert.match(r.headers.get('access-control-allow-headers'), /authorization/i); assert.match(r.headers.get('access-control-allow-headers'), /x-file-name/i);
      for (const m of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) assert.match(r.headers.get('access-control-allow-methods'), new RegExp(m));
      assert.equal(r.headers.get('access-control-allow-credentials'), null); // credentials stay off, so a wildcard is never in play
    }
    assert.equal((await pre('http://evil.example.com')).headers.get('access-control-allow-origin'), null);
    const real = await fetch(url, { method: 'POST', headers: { Origin: 'http://localhost:5174', 'Content-Type': 'image/png' }, body: Buffer.alloc(8) });
    assert.equal(real.headers.get('access-control-allow-origin'), 'http://localhost:5174'); // error responses carry it too, so the browser can show them
  } finally { srv.close(); }
});
