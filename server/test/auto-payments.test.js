// Automatic payment detection from Messages: the pure rules (matching, review, duplicates), then the whole pipeline against a throwaway mongod.
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
import { matchOrder, reviewReasons, findPossibleDuplicate, displayStatus, buildLedger } from '../services/paymentLogic.js';

const ord = (o = {}) => ({ id: 'o1', customerName: 'Asha Rao', customerContact: '+91 98765 43210', status: 'in_progress', balance: 1000, ...o });

// ---- Pure rules ---------------------------------------------------------------------------------------------------------
test('matching: a linked chat, or the sender\'s own phone number, assigns the order', () => {
  assert.deepEqual(matchOrder({ orderId: 'o1' }, [ord()], 500).state, 'matched');
  const byPhone = matchOrder({ contactId: '919876543210', customerName: 'Someone else' }, [ord(), ord({ id: 'o2', customerContact: '+91 90000 00000' })], 500);
  assert.equal(byPhone.state, 'matched'); assert.equal(byPhone.orderId, 'o1');
});

test('matching: name only, several candidates, no candidate or an amount above the balance never assign an order silently', () => {
  const nameOnly = matchOrder({ contactId: 'x', customerName: 'asha  rao' }, [ord({ customerContact: null })], 500);
  assert.deepEqual([nameOnly.state, nameOnly.orderId, nameOnly.candidates], ['uncertain', null, ['o1']]);
  const two = matchOrder({ contactId: '919876543210' }, [ord(), ord({ id: 'o2', balance: 700 })], 300);
  assert.deepEqual([two.state, two.orderId, two.candidates], ['uncertain', null, ['o1', 'o2']]);
  const byAmount = matchOrder({ contactId: '919876543210' }, [ord(), ord({ id: 'o2', balance: 700 })], 700);
  assert.deepEqual([byAmount.state, byAmount.orderId], ['matched', 'o2']); // exactly one open balance equals the amount
  assert.equal(matchOrder({ contactId: 'nobody', customerName: 'Nobody' }, [ord()], 500).state, 'unmatched');
  assert.equal(matchOrder({ contactId: '919876543210' }, [ord({ status: 'cancelled' })], 500).state, 'unmatched');
  assert.equal(matchOrder({ contactId: '919876543210' }, [ord({ balance: 0 })], 500).state, 'unmatched'); // already fully paid
  const over = matchOrder({ contactId: '919876543210' }, [ord()], 5000);
  assert.equal(over.state, 'uncertain'); assert.equal(over.orderId, null);
  const overLinked = matchOrder({ orderId: 'o1' }, [ord()], 5000);
  assert.deepEqual([overLinked.state, overLinked.orderId], ['uncertain', 'o1']); // the chat link is kept, but flagged
});

test('review reasons: low confidence, unmatched, no reference or a failed payment all need a person', () => {
  const ok = { x: { confidence: 0.9, transactionId: 'UTR1', succeeded: true }, match: { state: 'matched' }, hasMethod: true };
  assert.deepEqual(reviewReasons(ok), []);
  assert.equal(reviewReasons({ ...ok, x: { ...ok.x, confidence: 0.4 } }).length, 1);
  assert.equal(reviewReasons({ ...ok, match: { state: 'unmatched', reason: 'No open order.' } })[0], 'No open order.');
  assert.equal(reviewReasons({ ...ok, x: { ...ok.x, transactionId: null } }).length, 1);
  assert.equal(reviewReasons({ ...ok, x: { ...ok.x, succeeded: false } }).length, 1);
});

test('possible duplicates: same transaction ID, else same amount + method at the same minute; a rejected record frees it', () => {
  const a = { id: 'a', status: 'pending', kind: 'payment', amount: 500, method: 'upi', transactionId: 'UTR 123 456', paidAt: '2026-10-01T10:00:20Z' };
  assert.equal(findPossibleDuplicate([a], { key: 'UTR123456', amount: 1, method: 'cash', paidAt: null })?.id, 'a');
  assert.equal(findPossibleDuplicate([a], { key: null, amount: 500, method: 'upi', paidAt: '2026-10-01T10:00:50Z' })?.id, 'a');
  assert.equal(findPossibleDuplicate([a], { key: null, amount: 500, method: 'upi', paidAt: '2026-10-01T10:05:00Z' }), null);
  assert.equal(findPossibleDuplicate([a], { key: null, amount: 501, method: 'upi', paidAt: '2026-10-01T10:00:20Z' }), null);
  assert.equal(findPossibleDuplicate([{ ...a, status: 'rejected' }], { key: 'UTR123456', amount: 500, method: 'upi', paidAt: null }), null);
});

test('extracted, matched and verified are separate: only the owner\'s confirmation reads as Verified', () => {
  const p = { status: 'pending', orderId: 'o1', match: { state: 'matched', reviewRequired: false } };
  assert.equal(displayStatus(p), 'awaiting_verification');
  assert.equal(displayStatus({ ...p, match: { state: 'matched', reviewRequired: true } }), 'pending_review');
  assert.equal(displayStatus({ ...p, orderId: null }), 'pending_review');
  assert.equal(displayStatus({ ...p, review: { mode: 'needs_review' } }), 'pending_review');
  assert.equal(displayStatus({ ...p, status: 'confirmed' }), 'verified');
  assert.equal(displayStatus({ ...p, status: 'rejected' }), 'rejected');
  const ledger = buildLedger([{ id: 'o1', customerName: 'A', item: 'x', price: 100 }], [{ id: 'p1', orderId: null, status: 'pending', kind: 'payment', amount: 50, method: 'upi' }]);
  assert.equal(ledger.unassigned.length, 1); assert.equal(ledger.rows[0].payments.length, 0); assert.equal(ledger.kpis.toReview, 1); assert.equal(ledger.kpis.totalReceived, 0);
});

// ---- Pipeline ---------------------------------------------------------------------------------------------------------
const hasMongod = spawnSync('mongod', ['--version']).status === 0;
const skip = hasMongod ? false : 'mongod not installed: integration tests skipped';
let proc; let server; let base; let dir; let proofDir; let ingest; let scansIdle; const realFetch = globalThis.fetch;
let reading = null; // what the stubbed vision model answers

before(async () => {
  if (!hasMongod) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversa-auto-'));
  proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversa-autoproof-'));
  config.payments.proofDir = proofDir;
  const port = 29000 + Math.floor(Math.random() * 1000);
  proc = spawn('mongod', ['--dbpath', dir, '--port', String(port), '--bind_ip', '127.0.0.1', '--nounixsocket'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { if (await connectDb(`mongodb://127.0.0.1:${port}/conversa_auto_test`)) break; await new Promise((r) => setTimeout(r, 500)); }
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
  await mongoose.model('Payment').init();
  { const mod = await import('../services/messageService.js'); ingest = async (x) => { const r = await mod.ingest(x); await mod.mediaIdle(); return r; }; } // pictures download after the message is stored
  ({ scansIdle } = await import('../services/paymentAutoDetect.js'));
  config.meta.whatsapp.accessToken = 'wa-token';
  config.groq.apiKey = 'test-key';
  // Meta serves the picture (bytes depend on the media id), Groq answers with `reading`.
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('graph.facebook.com')) return new Response(JSON.stringify({ url: `https://lookaside.fbsbx.com/x?m=${u.split('/').pop()}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.includes('lookaside.fbsbx.com')) return new Response(img(Number(u.split('m=').pop().replace(/\D/g, '')) || 1), { status: 200 });
    if (u.includes('groq.com')) {
      if (reading === 'down') return new Response('{}', { status: 500 });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reading) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, init);
  };
});
after(async () => { globalThis.fetch = realFetch; config.meta.whatsapp.accessToken = ''; config.groq.apiKey = ''; server?.close(); await mongoose.disconnect(); proc?.kill(); for (const d of [dir, proofDir]) if (d) fs.rmSync(d, { recursive: true, force: true }); });

const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : null };
};
const img = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), Buffer.alloc(40, n)]);
const READ = (o = {}) => ({ isPaymentScreenshot: true, amount: 600, transactionId: 'UTR900000000001', method: 'upi', status: 'success', confidence: 0.9, paidAt: '2026-10-29T11:42:00+05:30', uncertainties: [], ...o });
let seq = 100;
const newOrder = async (extra = {}) => (await call('POST', '/orders', { customerName: 'Asha Rao', item: 'Cake', quantity: 1, price: 1000, status: 'in_progress', ...extra })).json;
// A customer sends a picture over WhatsApp; resolves once the background reading is finished.
async function arrives({ contactId, name = 'Asha Rao', image = ++seq, externalId = `wamid.auto${++seq}` }) {
  const r = await ingest([{ channel: 'whatsapp', contactId, contactName: name, externalId, messageType: 'image', text: null, mediaId: `MEDIA${image}`, receivedAt: new Date() }]);
  await scansIdle();
  const Message = mongoose.model('Message');
  return { ...r, msg: await Message.findOne({ externalId }).lean() };
}
const payments = async () => (await call('GET', '/payments')).json;
const linkChat = async (contactId, orderId) => mongoose.model('Conversation').updateOne({ channel: 'whatsapp', contactId }, { $set: { orderId } }, { upsert: true });
const allFor = async (orderId) => (await payments()).rows.find((r) => r.orderId === orderId).payments;

test('a screenshot in a chat linked to an order is read, filed as Awaiting Verification and never as paid', { skip }, async () => {
  const o = await newOrder(); await linkChat('9100000001', o.id); reading = READ();
  const { msg } = await arrives({ contactId: '9100000001' });
  assert.equal(msg.paymentScan.state, 'filed'); assert.ok(msg.paymentId);
  const [p] = await allFor(o.id);
  assert.equal(p.source, 'auto_screenshot'); assert.equal(p.status, 'pending'); assert.equal(p.displayStatus, 'awaiting_verification');
  assert.deepEqual([p.amount, p.method, p.transactionId], [600, 'upi', 'UTR900000000001']);
  assert.equal(p.match.state, 'matched'); assert.equal(p.match.auto, true); assert.equal(p.extraction.method, 'vision');
  assert.ok(p.proof); assert.equal(p.messageId, String(msg._id)); assert.equal(String(p.conversationId), String(msg.conversation));
  assert.equal(p.sourceMessage.conversationId, String(msg.conversation)); // the Payments view can show where it came from
  const after = (await call('GET', `/orders/${o.id}`)).json;
  assert.equal(after.paymentStatus, 'pending'); assert.equal(after.status, 'in_progress'); // claimed, not received
  const row = (await payments()).rows.find((r) => r.orderId === o.id);
  assert.deepEqual([row.paid, row.balance], [0, 1000]);
  const chat = (await call('GET', '/conversations')).json.items.find((c) => c.id === String(msg.conversation)).messages[0];
  assert.equal(chat.scan.state, 'filed'); assert.equal(chat.payment.displayStatus, 'awaiting_verification');
  const c = await call('POST', `/payments/${p.id}/confirm`, { acknowledged: true, reviewer: 'Asha' }); // only the owner can verify
  assert.equal(c.json.payment.displayStatus, 'verified');
});

test('a picture that is not a payment screenshot creates nothing', { skip }, async () => {
  const o = await newOrder(); await linkChat('9100000002', o.id); reading = { isPaymentScreenshot: false, amount: null, confidence: 0.9 };
  const { msg } = await arrives({ contactId: '9100000002' });
  assert.equal(msg.paymentScan.state, 'not_payment'); assert.equal(msg.paymentId ?? null, null);
  assert.equal((await allFor(o.id)).length, 0);
});

test('failed extraction is reported on the message, saves no payment, and can be retried', { skip }, async () => {
  const o = await newOrder(); await linkChat('9100000003', o.id);
  reading = READ({ amount: null });
  const a = await arrives({ contactId: '9100000003' });
  assert.equal(a.msg.paymentScan.state, 'failed'); assert.match(a.msg.paymentScan.reason, /amount/);
  reading = 'down';
  const b = await arrives({ contactId: '9100000003' });
  assert.equal(b.msg.paymentScan.state, 'failed'); // the AI service being down never loses the message
  assert.equal((await allFor(o.id)).length, 0);
  reading = READ({ transactionId: 'UTR900000000003', amount: 603 });
  const retry = await call('POST', `/conversations/${b.msg.conversation}/messages/${b.msg._id}/extract-payment`);
  assert.equal(retry.status, 201); assert.equal(retry.json.payment.orderId, o.id);
  assert.equal((await allFor(o.id)).length, 1);
});

test('an unlinked chat is matched by the sender\'s phone number', { skip }, async () => {
  const o = await newOrder({ customerName: 'Different Name', customerContact: '+91 91000 00004' }); reading = READ({ transactionId: 'UTR900000000004', amount: 604 });
  await arrives({ contactId: '919100000004', name: 'Someone' });
  const [p] = await allFor(o.id);
  assert.equal(p.match.state, 'matched'); assert.equal(p.displayStatus, 'awaiting_verification');
});

test('an uncertain match stays unassigned in Pending Review until the owner picks the order', { skip }, async () => {
  const o = await newOrder({ customerName: 'Meera Nair', customerContact: null }); reading = READ({ transactionId: 'UTR900000000005', amount: 605 });
  const { msg } = await arrives({ contactId: '9100000005', name: 'meera nair' }); // name only: suggested, not assigned
  assert.equal(msg.paymentScan.state, 'review');
  const led = await payments();
  const p = led.unassigned.find((x) => x.messageId === String(msg._id));
  assert.ok(p); assert.equal(p.orderId, null); assert.equal(p.displayStatus, 'pending_review'); assert.deepEqual(p.match.candidates, [o.id]);
  assert.equal(led.rows.find((r) => r.orderId === o.id).payments.length, 0);
  assert.equal((await call('GET', `/orders/${o.id}`)).json.paymentStatus, 'unverified');
  assert.equal((await call('POST', `/payments/${p.id}/confirm`, { acknowledged: true, reviewer: 'Asha' })).status, 409); // cannot verify what has no order
  assert.equal((await call('POST', `/payments/${p.id}/assign`, { orderId: o.id })).status, 422); // the owner's name is recorded
  const a = await call('POST', `/payments/${p.id}/assign`, { orderId: o.id, reviewer: 'Asha' });
  assert.equal(a.status, 200); assert.equal(a.json.payment.orderId, o.id); assert.equal(a.json.payment.status, 'pending');
  assert.equal(a.json.payment.displayStatus, 'awaiting_verification'); assert.equal(a.json.payment.match.by, 'Asha');
  assert.equal((await call('GET', `/orders/${o.id}`)).json.paymentStatus, 'pending');
  assert.equal((await call('POST', `/payments/${p.id}/assign`, { orderId: o.id, reviewer: 'Asha' })).status, 409);
});

test('an unknown sender is filed with no order at all', { skip }, async () => {
  reading = READ({ transactionId: 'UTR900000000006', amount: 606 });
  const { msg } = await arrives({ contactId: '9100000006', name: 'Stranger' });
  const p = (await payments()).unassigned.find((x) => x.messageId === String(msg._id));
  assert.equal(p.match.state, 'unmatched'); assert.equal(p.displayStatus, 'pending_review'); assert.equal(p.status, 'pending');
});

test('low confidence or a missing reference sends a matched payment to Pending Review', { skip }, async () => {
  const o = await newOrder(); await linkChat('9100000007', o.id); reading = READ({ confidence: 0.3, transactionId: null, amount: 607 });
  await arrives({ contactId: '9100000007' });
  const [p] = await allFor(o.id);
  assert.equal(p.match.state, 'matched'); assert.equal(p.displayStatus, 'pending_review'); assert.equal(p.match.reviewRequired, true);
  assert.equal(p.status, 'pending'); assert.ok(p.extraction.confidence <= 0.3);
});

test('duplicates: a repeated message, a repeated image, a repeated transaction and a double trigger all give one payment', { skip }, async () => {
  const o = await newOrder(); await linkChat('9100000008', o.id); reading = READ({ transactionId: 'UTR900000000008', amount: 608 });
  const first = await arrives({ contactId: '9100000008', image: 80, externalId: 'wamid.dup1' });
  assert.equal(first.msg.paymentScan.state, 'filed');
  const again = await ingest([{ channel: 'whatsapp', contactId: '9100000008', externalId: 'wamid.dup1', messageType: 'image', mediaId: 'MEDIA80', receivedAt: new Date() }]);
  await scansIdle(); assert.deepEqual([again.stored, again.duplicates], [0, 1]); // webhook retry
  const sameImage = await arrives({ contactId: '9100000008', image: 80, externalId: 'wamid.dup2' }); // same picture, new message
  assert.equal(sameImage.msg.paymentScan.state, 'duplicate'); assert.equal(String(sameImage.msg.paymentId), String(first.msg.paymentId));
  const sameTxn = await arrives({ contactId: '9100000008', image: 81, externalId: 'wamid.dup3' }); // different picture, same transaction
  assert.equal(sameTxn.msg.paymentScan.state, 'duplicate');
  reading = READ({ transactionId: null, amount: 250, paidAt: '2026-10-30T09:15:10+05:30' });
  await arrives({ contactId: '9100000008', image: 82, externalId: 'wamid.dup4' });
  const noRef = await arrives({ contactId: '9100000008', image: 83, externalId: 'wamid.dup5' }); // no transaction ID: amount + method + minute
  assert.equal(noRef.msg.paymentScan.state, 'duplicate');
  assert.equal((await allFor(o.id)).length, 2);

  const { processMessageImage } = await import('../services/paymentAutoDetect.js');
  assert.equal((await processMessageImage(first.msg._id)).state, 'skipped'); // already handled: a second worker does nothing
});

test('a rejected payment frees its screenshot and transaction for a corrected record', { skip }, async () => {
  const o = await newOrder(); await linkChat('9100000009', o.id); reading = READ({ transactionId: 'UTR900000000009', amount: 609 });
  const a = await arrives({ contactId: '9100000009', image: 90 });
  await call('POST', `/payments/${a.msg.paymentId}/reject`, { mode: 'reject', reviewer: 'Asha', note: 'Not received' });
  const b = await arrives({ contactId: '9100000009', image: 91 });
  assert.equal(b.msg.paymentScan.state, 'filed', b.msg.paymentScan.reason);
});
