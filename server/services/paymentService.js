// Payments on top of Mongoose. The rules live in paymentLogic.js; this file loads, writes and keeps the order's payment summary in step.
// Nothing here ever changes an order's production status.
import Order from '../models/Order.js';
import Payment from '../models/Payment.js';
import Conversation from '../models/Conversation.js';
import { ApiError, notFound, validationError } from '../utils/errors.js';
import { orderFilter } from '../utils/dataset.js';
import { config } from '../config/env.js';
import { groqJson } from './groqClient.js';
import { isDbReady } from '../config/db.js';
import Message from '../models/Message.js';
import { saveProof, readProof, deleteProof, checkImage, hashImage } from './proofStore.js';
import { parsePaymentText, validateVisionOutput, toReading as pureReading, VISION_PROMPT } from './paymentExtraction.js';
import {
  buildLedger, summarize, orderPaymentStatus, toPublic, txnKey, findDuplicate, duplicateError, findSameTransaction, reconcilePatch,
  validatePaymentInput, validateConfirm, validateReject, validateRefund, duplicateProofError,
} from './paymentLogic.js';

const ID = /^[a-f\d]{24}$/i;
const plain = (doc) => doc.toJSON();
export const publicPayment = (doc) => toPublic(forLogic(plain(doc)));
const forLogic = (p) => ({ ...p, proof: p.proof ? { contentType: p.proof.contentType, size: p.proof.size } : null });

async function loadOrder(id) {
  if (!ID.test(String(id))) throw notFound('Order', id);
  const o = await Order.findById(id);
  if (!o) throw notFound('Order', id);
  return o;
}
async function loadPayment(id) {
  if (!ID.test(String(id))) throw notFound('Payment', id);
  const p = await Payment.findById(id);
  if (!p) throw notFound('Payment', id);
  return p;
}
const paymentsOf = async (orderId) => (await Payment.find({ order: orderId })).map(plain).map(forLogic);

// Keeps Order.paymentStatus matching its records (see orderPaymentStatus). Only that one field is written; status is never touched.
export async function syncOrder(orderId) {
  const order = await loadOrder(orderId);
  const next = orderPaymentStatus(order.toJSON(), await paymentsOf(orderId));
  if (next !== order.paymentStatus) await Order.updateOne({ _id: order._id }, { $set: { paymentStatus: next } });
  return next;
}

// The message a payment was detected in, so the owner can see what the customer actually wrote next to the screenshot.
async function sourceMessages(payments) {
  const ids = [...new Set(payments.map((p) => p.messageId).filter((m) => ID.test(String(m))))];
  if (!ids.length) return {};
  const msgs = await Message.find({ _id: { $in: ids } }).lean();
  const convs = await Conversation.find({ _id: { $in: msgs.map((m) => m.conversation) } }).lean();
  const cBy = Object.fromEntries(convs.map((c) => [String(c._id), c]));
  return Object.fromEntries(msgs.map((m) => {
    const c = cBy[String(m.conversation)];
    return [String(m._id), { conversationId: String(m.conversation), customerName: c?.customerName ?? null, channel: m.channel, text: m.text ?? null, at: m.receivedAt?.toISOString?.() ?? null }];
  }));
}

export async function getLedger(dataset = 'all') {
  const [orders0, payments0] = await Promise.all([Order.find(orderFilter(dataset)).limit(5000), Payment.find().limit(20000)]);
  const ids = new Set(orders0.map((o) => String(o._id)));
  const orders = orders0; // payments follow their order; a payment with no order yet follows its own demo flag
  const payments = dataset === 'all' ? payments0 : payments0.filter((p) => (p.order ? ids.has(String(p.order)) : (dataset === 'demo') === Boolean(p.isDemo)));
  const ledger = buildLedger(orders.map(plain), payments.map(plain).map(forLogic));
  const src = await sourceMessages(payments);
  const attach = (p) => (p.messageId && src[p.messageId] ? { ...p, sourceMessage: src[p.messageId] } : p);
  ledger.unassigned = ledger.unassigned.map(attach);
  for (const r of ledger.rows) r.payments = r.payments.map(attach);
  return ledger;
}

export async function getPayment(id) {
  const p = await loadPayment(id);
  const sm = p.messageId ? (await sourceMessages([p]))[p.messageId] : null;
  const payment = { ...toPublic(forLogic(plain(p))), ...(sm ? { sourceMessage: sm } : {}) };
  if (!p.order) return { payment, order: null, summary: null };
  const order = await loadOrder(p.order);
  const all = await paymentsOf(order.id);
  return { payment, order: { id: order.id, customerName: order.customerName, item: order.item, quantity: order.quantity, price: order.price ?? null, status: order.status }, summary: summarize(order.toJSON(), all) };
}

// The one payment (pending or confirmed) already filed from this exact image, if any.
export async function existingByHash(hash) {
  if (!hash) return null;
  const p = await Payment.findOne({ proofHash: hash, status: { $in: ['pending', 'confirmed'] } });
  return p ? { id: p.id, status: p.status, orderId: String(p.order) } : null;
}

export function historyEntry(action, by, note) { return { at: new Date(), action, by: by ?? null, note: note ?? null }; }

async function insert(doc) {
  try { return await Payment.create(doc); } catch (e) {
    if (e.code === 11000) throw e.keyPattern?.proofHash ? duplicateProofError(await existingByHash(doc.proofHash)) : duplicateError({ transactionId: doc.transactionId, id: 'existing' });
    throw e;
  }
}

// POST /api/payments: the owner records a payment. It starts as Verification pending unless the owner says they have checked it.
export async function createPayment(body, { source = 'manual', proofBuffer = null, proofMeta = null, proofName = null, extra = {} } = {}) {
  const { value, details } = validatePaymentInput(body);
  if (details.length) throw validationError(details);
  const order = await loadOrder(value.orderId);
  if (order.status === 'cancelled') throw new ApiError(409, 'CONFLICT', 'This order is cancelled, so no payment can be recorded against it.');
  const existing = await paymentsOf(order.id);
  const key = txnKey(value.transactionId);
  // A screenshot (or a payment read from one) of a transaction already on this order updates that record instead of adding a second one.
  // Typing the same reference in by hand, with nothing to add to the record, is still refused as a duplicate.
  const evidence = Boolean(value.extraction || proofBuffer || proofMeta || source !== 'manual');
  const same = evidence ? findSameTransaction(existing, { key, amount: value.amount, method: value.method, paidAt: value.paidAt }, order.toJSON()) : null;
  if (same) return reconcileInto(same, order, { value, key, proofBuffer, proofMeta, proofName, extra });
  const dup = findDuplicate(existing, key);
  if (dup) throw duplicateError(dup);
  const sum = summarize(order.toJSON(), existing);
  if (value.method === 'cod' && sum.balance !== null && value.amount - sum.balance > 0.005) throw new ApiError(422, 'EXCEEDS_BALANCE', `COD amount is more than the remaining balance (${sum.balance}).`, [{ field: 'amount', message: `At most ${sum.balance}.` }]);
  if (value.confirmed && sum.balance !== null && value.amount - sum.balance > 0.005) throw new ApiError(422, 'EXCEEDS_BALANCE', `This would record ${value.amount} against a remaining balance of ${sum.balance}.`, [{ field: 'amount', message: `At most ${sum.balance} can be confirmed.` }]);

  // A payment entered by hand that carries the owner's reading of a screenshot is a screenshot upload, not a plain manual entry.
  if (value.extraction && source === 'manual') { source = 'screenshot_upload'; extra = { extraction: { ...value.extraction, extractedAt: new Date() }, ...extra }; }
  const hash = proofMeta?.sha256 ?? (proofBuffer ? hashImage(proofBuffer) : null);
  const dupProof = await existingByHash(hash);
  if (dupProof) throw duplicateProofError(dupProof);
  const proof = proofMeta ?? (proofBuffer ? await saveProof(proofBuffer, proofName) : null);
  const confirmed = value.confirmed && value.method !== 'cod' ? true : value.confirmed; // a COD collection the owner ticked is confirmed too
  const now = new Date();
  try {
    const doc = await insert({
      order: order._id, amount: value.amount, method: value.method, transactionId: value.transactionId ?? null, transactionKey: key, paidAt: value.paidAt ?? (value.method === 'cod' ? null : now),
      source, notes: value.notes ?? null, proof, proofHash: proof?.sha256 ?? null, status: confirmed ? 'confirmed' : 'pending',
      review: confirmed ? { by: value.reviewer, at: now, confirmedAmount: value.amount, mode: 'manual_entry', note: 'Entered by the owner as already received.' } : null,
      history: [historyEntry(source === 'manual' ? 'recorded' : 'extracted', confirmed ? value.reviewer : null, confirmed ? 'Recorded as received by the owner.' : 'Waiting for the owner to verify.'), ...(confirmed ? [historyEntry('confirmed', value.reviewer, 'Owner confirmed the money arrived (manual check).')] : [])],
      ...extra,
    });
    await syncOrder(order.id);
    return toPublic(forLogic(plain(doc)));
  } catch (e) { if (proof && !proofMeta) await deleteProof(proof); throw e; }
}

// The screenshot describes a payment that is already on the order: update that record (same id, same order) and say so. Never creates a record.
async function reconcileInto(same, order, { value, key, proofBuffer, proofMeta, proofName, extra }) {
  const doc = await loadPayment(same.id);
  const hash = proofMeta?.sha256 ?? (proofBuffer ? hashImage(proofBuffer) : null);
  const owner = hash ? await existingByHash(hash) : null;
  if (owner && owner.id !== same.id) throw duplicateProofError(owner); // that picture belongs to a different payment
  const ownImage = Boolean(hash) && doc.proofHash === hash; // the very same picture again: nothing to add
  const patch = reconcilePatch(same, { amount: value.amount, transactionId: value.transactionId, paidAt: value.paidAt, extraction: value.extraction ? { ...value.extraction, extractedAt: new Date() } : extra.extraction, hasProof: Boolean(proofBuffer || proofMeta) && !ownImage });
  const note = ownImage ? 'The same screenshot was uploaded again; no new record was made.' : patch.note;
  const mode = ownImage ? 'already_recorded' : patch.mode;
  const set = { ...patch.set };
  if (patch.attachProof) { const proof = proofMeta ?? await saveProof(proofBuffer, proofName); Object.assign(set, { proof, proofHash: proof.sha256 }); }
  if (!doc.conversation && extra.conversation) set.conversation = extra.conversation;
  if (!doc.messageId && extra.messageId) set.messageId = extra.messageId;
  await Payment.updateOne({ _id: doc._id }, { $set: set, $push: { history: historyEntry(mode === 'already_recorded' ? 'duplicate_ignored' : patch.attachProof ? 'proof_added' : 'updated', null, note) } });
  await syncOrder(order.id);
  return { ...toPublic(forLogic(plain(await loadPayment(same.id)))), reconciled: mode };
}

export async function attachProof(id, buf, name) {
  const p = await loadPayment(id);
  if (p.proof) throw new ApiError(409, 'CONFLICT', 'This payment already has a screenshot.');
  checkImage(buf);
  const dup = await existingByHash(hashImage(buf));
  if (dup) throw duplicateProofError(dup);
  p.proof = await saveProof(buf, name);
  p.proofHash = p.proof.sha256;
  p.history.push(historyEntry('proof_added', null, 'Screenshot attached.'));
  await p.save();
  return toPublic(forLogic(plain(p)));
}

export async function getProofFile(id) {
  const p = await loadPayment(id);
  const data = await readProof(p.proof);
  if (!data) throw notFound('Proof', id);
  return { data, contentType: p.proof.contentType };
}

export async function confirmPayment(id, body) {
  const p = await loadPayment(id);
  if (!p.order) throw new ApiError(409, 'CONFLICT', 'This payment is not matched to an order yet. Choose the order first, then confirm it.');
  const order = await loadOrder(p.order);
  const all = await paymentsOf(order.id);
  const v = validateConfirm(body, forLogic(plain(p)), summarize(order.toJSON(), all.filter((x) => x.id !== p.id)));
  const key = txnKey(v.transactionId);
  const dup = findDuplicate(all, key, p.id);
  if (dup) throw duplicateError(dup);
  const now = new Date();
  const res = await Payment.findOneAndUpdate({ _id: p._id, status: 'pending' }, {
    $set: { status: 'confirmed', amount: v.amount, transactionId: v.transactionId, transactionKey: key, paidAt: p.paidAt ?? now, review: { by: v.reviewer, at: now, note: v.note, confirmedAmount: v.amount, mode: 'confirmed' } },
    $push: { history: historyEntry('confirmed', v.reviewer, `Owner confirmed ${v.amount} arrived${v.amount !== p.amount ? ` (claimed ${p.amount})` : ''}. Checked manually; not verified with a bank.`) },
  }, { new: true });
  if (!res) throw new ApiError(409, 'CONFLICT', 'This payment was just changed by someone else. Reload and check it.');
  await syncOrder(order.id);
  return getPayment(id);
}

export async function rejectPayment(id, body) {
  const p = await loadPayment(id);
  const v = validateReject(body);
  if (p.status !== 'pending') throw new ApiError(409, 'CONFLICT', `This payment is already ${p.status}.`);
  const review = { by: v.reviewer, at: new Date(), note: v.note, mode: v.mode === 'reject' ? 'rejected' : 'needs_review' };
  const set = v.mode === 'reject'
    ? { status: 'rejected', review }
    : { review, extraction: { ...(p.extraction?.toObject?.() ?? {}), method: p.extraction?.method ?? 'manual', needsReview: true, issues: [...(p.extraction?.issues ?? []), ...(v.note ? [v.note] : [])] } };
  await Payment.updateOne({ _id: p._id }, { $set: set, $push: { history: historyEntry(v.mode === 'reject' ? 'rejected' : 'needs_review', v.reviewer, v.note) } });
  if (p.order) await syncOrder(p.order);
  return getPayment(id);
}

export async function refundPayment(id, body) {
  const original = await loadPayment(id);
  const siblings = await paymentsOf(original.order);
  const v = validateRefund(body, forLogic(plain(original)), siblings);
  const now = new Date();
  await Payment.create({
    order: original.order, kind: 'refund', refundOf: original._id, amount: v.amount, method: original.method, status: 'confirmed', paidAt: now, source: 'manual', notes: v.reason,
    review: { by: v.reviewer, at: now, confirmedAmount: v.amount, mode: 'refund', note: v.reason }, history: [historyEntry('refunded', v.reviewer, v.reason)],
  });
  await Payment.updateOne({ _id: original._id }, { $push: { history: historyEntry('refund_recorded', v.reviewer, `${v.amount} refunded: ${v.reason}`) } });
  await syncOrder(original.order);
  return getPayment(id);
}

// ---- Chat extraction ----------------------------------------------------------------------------------------------------
async function linkedOrderId({ orderId, conversationId }) {
  if (orderId) return orderId;
  if (conversationId && ID.test(conversationId)) return (await Conversation.findById(conversationId))?.orderId?.toString() ?? null;
  return null;
}

// A customer's chat message becomes a Verification pending record: a claim, never money received.
export async function extractFromText({ message, orderId, conversationId, messageId, receivedAt }) {
  if (typeof message !== 'string' || !message.trim()) throw validationError([{ field: 'message', message: 'Message is required.' }]);
  const x = parsePaymentText(message);
  const extraction = { isPayment: x.isPayment, amount: x.amount, transactionId: x.transactionId, method: x.method, confidence: x.confidence, issues: x.issues };
  if (!x.isPayment) return { payment: null, extraction, reason: 'This message does not look like a payment.' };
  const oid = await linkedOrderId({ orderId, conversationId });
  if (!oid) return { payment: null, extraction, reason: 'Link this chat to an order first, so the payment goes to the right one.' };
  if (x.amount === null) return { payment: null, extraction, reason: 'No amount was found. Record the payment by hand and the details will be kept for review.' };
  const method = x.method ?? 'other';
  const when = x.date ? new Date(Date.UTC(x.date.year, x.date.month - 1, x.date.day, x.date.hour ?? 12, x.date.minute ?? 0)) : null;
  const payment = await createPayment({ orderId: oid, amount: x.amount, method: method === 'cod' ? 'cod' : method, transactionId: x.transactionId ?? undefined, paidAt: when && when <= new Date() ? when.toISOString() : (receivedAt ? new Date(receivedAt).toISOString() : undefined), notes: 'Read from a chat message. Not yet verified.' },
    { source: 'chat_text', extra: { conversation: conversationId && ID.test(conversationId) ? conversationId : null, messageId: messageId ?? null, extraction: { method: 'text', confidence: x.confidence, needsReview: true, issues: x.issues, recipient: null, model: 'rules', extractedAt: new Date() } } });
  return { payment, extraction, reason: null };
}

// Reads a payment screenshot with the vision model (GROQ_VISION_MODEL). THE one reading service: Inbox, the Payments modal and the
// browser demo all come through here. It writes nothing. Fails closed: if the picture cannot be read into an amount it throws, and the
// caller offers manual entry instead.
// The model's answer, validated. Says whether the picture is a payment screenshot at all; callers decide what to do when it is not.
export async function visionRead(buffer) {
  const mime = checkImage(buffer).type;
  const raw = await groqJson({ ...VISION_PROMPT, image: `data:${mime};base64,${buffer.toString('base64')}` }); // throws AI_UNAVAILABLE without a key
  try { return validateVisionOutput(raw); } catch { throw new ApiError(422, 'EXTRACTION_FAILED', 'The screenshot could not be read reliably. Enter the payment by hand and keep the screenshot attached.'); }
}

export async function readScreenshot(buffer) {
  return toReading(await visionRead(buffer));
}

export const toReading = (x) => pureReading(x, config.groq.visionModel);

// POST /payments/read-image: the reading, plus whether this exact image is already filed. Saves nothing and stores nothing.
export async function readImageOnly(buffer) {
  const extraction = await readScreenshot(buffer);
  const proofHash = hashImage(buffer);
  const duplicate = isDbReady() ? await existingByHash(proofHash) : null; // demo mode without a database checks in the browser instead
  return { extraction, proofHash, duplicate };
}

export const recordExtraction = (x) => ({ method: 'vision', confidence: x.extractionConfidence, needsReview: true, issues: x.warnings, recipient: x.recipientDetails, model: x.model, extractedAt: new Date() });

// Reads a screenshot and files it as a Verification pending payment on the order. Used by the Inbox (a screenshot in a chat) and by
// anything that has an image and an order. Nothing is stored if the reading fails.
export async function extractFromImage({ buffer, proofMeta = null, orderId, conversationId, messageId = null, fileName }) {
  checkImage(buffer);
  const oid = await linkedOrderId({ orderId, conversationId });
  if (!oid) throw validationError([{ field: 'orderId', message: 'Choose the order this screenshot is for.' }]);
  await loadOrder(oid);
  const dup = await existingByHash(hashImage(buffer)); // refuse before spending a model call on an image that is already filed
  if (dup) throw duplicateProofError(dup);
  const x = await readScreenshot(buffer);
  const paidAt = x.paymentDate && new Date(x.paymentDate) <= new Date() ? x.paymentDate : undefined;
  const payment = await createPayment({ orderId: oid, amount: x.amount, method: x.paymentMethod ?? 'other', transactionId: x.transactionId ?? undefined, paidAt, notes: 'Read from a screenshot. Not yet verified.' },
    { source: 'chat_screenshot', proofBuffer: proofMeta ? null : buffer, proofMeta, proofName: fileName, extra: { conversation: conversationId && ID.test(conversationId) ? conversationId : null, messageId, extraction: recordExtraction(x) } });
  return { payment, extraction: x };
}

// Called as webhook messages arrive: a payment-looking text in a chat that is already linked to an order becomes a pending record.
// Failures here must never lose the message, so they are swallowed.
export async function draftFromIncoming(conv, text, messageId, receivedAt) {
  try {
    if (!conv?.orderId || !text) return null;
    const r = await extractFromText({ message: text, orderId: String(conv.orderId), conversationId: String(conv._id), messageId, receivedAt });
    return r.payment;
  } catch { return null; }
}


// The owner picks the order for a payment that was detected but could not be matched safely. Nothing else about it changes: it stays
// unverified (and stays in Pending Review only if the reading itself was doubtful).
export async function assignPayment(id, body) {
  const p = await loadPayment(id);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw validationError([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details = [];
  if (typeof body.orderId !== 'string' || !ID.test(body.orderId)) details.push({ field: 'orderId', message: 'Choose the order this payment is for.' });
  if (typeof body.reviewer !== 'string' || !body.reviewer.trim() || body.reviewer.trim().length > 80) details.push({ field: 'reviewer', message: 'Enter your name so this is recorded.' });
  if (details.length) throw validationError(details);
  if (p.order) throw new ApiError(409, 'CONFLICT', 'This payment already belongs to an order.');
  if (p.status !== 'pending') throw new ApiError(409, 'CONFLICT', `This payment is already ${p.status}.`);
  const order = await loadOrder(body.orderId);
  if (order.status === 'cancelled') throw new ApiError(409, 'CONFLICT', 'This order is cancelled, so no payment can be recorded against it.');
  const dup = findDuplicate(await paymentsOf(order.id), txnKey(p.transactionId), p.id);
  if (dup) throw duplicateError(dup);
  const m = p.match?.toObject?.() ?? p.match ?? {};
  await Payment.updateOne({ _id: p._id, order: null }, {
    $set: { order: order._id, match: { ...m, state: 'matched', by: body.reviewer.trim(), reason: 'Order chosen by the owner.', reviewRequired: Boolean(m.lowConfidence) } },
    $push: { history: historyEntry('assigned', body.reviewer.trim(), `Matched to ${order.customerName} · ${order.item}.`) },
  });
  await syncOrder(order.id);
  return getPayment(id);
}
