// Payment rules as pure functions of (order, payment records). The server (Mongoose) and the offline demo backend both run these,
// so the ledger, the balances and the checks are identical in both.
//
// The model, in one paragraph: a payment RECORD is a claim ("the customer says they paid 1,800 by UPI") or a fact ("the owner checked
// and confirmed it"). Only CONFIRMED records count as money received. An order's balance is its total minus confirmed payments plus
// confirmed refunds, so a claim, a screenshot or a COD promise can never make an order look paid. Production status is never touched.
import { ApiError, validationError } from '../utils/errors.js';
import { parseIsoDate, isPlainObject } from '../utils/validation.js';

export const METHODS = ['upi', 'bank_transfer', 'cash', 'cod', 'other'];
export const PAYMENT_RECORD_STATUSES = ['pending', 'confirmed', 'rejected'];
export const PAYMENT_SOURCES = ['manual', 'chat_text', 'chat_screenshot', 'screenshot_upload', 'auto_screenshot'];
export const MATCH_STATES = ['matched', 'uncertain', 'unmatched'];
export const LOW_CONFIDENCE = 0.6;
export const MAX_AMOUNT = 10000000;
const PAID_TOLERANCE_MS = 5 * 60 * 1000;
const TXN = /^[A-Za-z0-9][A-Za-z0-9\-_/ ]{3,63}$/;
const EPS = 0.005;

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
// "utr 4123 9876 5431" and "UTR412398765431" are the same transaction.
export const txnKey = (id) => (typeof id === 'string' && id.trim() ? id.replace(/\s+/g, '').toUpperCase() : null);
const money = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_AMOUNT && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;

// ---- Input validation ---------------------------------------------------------------------------------------------------
// Body of POST /api/payments. `confirmed` + `reviewer` let the owner record money they have already checked; otherwise the record
// starts as Verification pending.
export function validatePaymentInput(body) {
  const details = [];
  const value = {};
  const add = (field, message) => details.push({ field, message });
  if (!isPlainObject(body)) return { value, details: [{ field: 'body', message: 'Request body must be a JSON object.' }] };
  const allowed = ['orderId', 'amount', 'method', 'transactionId', 'paidAt', 'notes', 'confirmed', 'reviewer', 'extraction'];
  for (const k of Object.keys(body)) if (!allowed.includes(k)) add(k, 'Unknown field.');

  if (typeof body.orderId !== 'string' || !/^[a-zA-Z0-9_-]{2,40}$/.test(body.orderId)) add('orderId', 'Choose the order this payment is for.');
  else value.orderId = body.orderId;
  if (!money(body.amount)) add('amount', `Must be an amount above 0 (up to ${MAX_AMOUNT.toLocaleString('en-IN')}) with at most 2 decimals.`);
  else value.amount = round2(body.amount);
  if (!METHODS.includes(body.method)) add('method', `Must be one of: ${METHODS.join(', ')}.`);
  else value.method = body.method;

  if (body.transactionId !== undefined && body.transactionId !== null && body.transactionId !== '') {
    if (typeof body.transactionId !== 'string' || !TXN.test(body.transactionId.trim())) add('transactionId', 'Use 4–64 letters, numbers, dashes or slashes.');
    else if (value.method === 'cod' || value.method === 'cash') add('transactionId', 'Cash and COD payments have no transaction ID.');
    else value.transactionId = body.transactionId.trim();
  }
  if (body.paidAt !== undefined && body.paidAt !== null && body.paidAt !== '') {
    const d = parseIsoDate(body.paidAt);
    if (!d) add('paidAt', 'Must be an ISO 8601 date and time with a timezone.');
    else if (d.getTime() > Date.now() + PAID_TOLERANCE_MS) add('paidAt', 'The payment date cannot be in the future.');
    else value.paidAt = d;
  }
  if (body.notes !== undefined && body.notes !== null) {
    if (typeof body.notes !== 'string' || body.notes.length > 500) add('notes', 'Notes must be text up to 500 characters.');
    else value.notes = body.notes.trim() || null;
  }
  if (body.extraction !== undefined && body.extraction !== null) {
    if (!isPlainObject(body.extraction)) add('extraction', 'Must be an object.');
    else value.extraction = sanitizeExtraction(body.extraction);
  }
  value.confirmed = body.confirmed === true;
  if (body.confirmed !== undefined && typeof body.confirmed !== 'boolean') add('confirmed', 'Must be true or false.');
  if (value.confirmed) {
    if (typeof body.reviewer !== 'string' || !body.reviewer.trim() || body.reviewer.trim().length > 80) add('reviewer', 'Enter your name so the confirmation is recorded.');
    else value.reviewer = body.reviewer.trim();
  }
  return { value, details };
}

// What the browser reports about a screenshot reading it did through /payments/read-image. It is only ever shown to the owner as
// context: it can never change a status or an amount, so it is trimmed and capped rather than trusted.
export function sanitizeExtraction(x) {
  const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) || null : null);
  const c = typeof x.extractionConfidence === 'number' && Number.isFinite(x.extractionConfidence) ? Math.max(0, Math.min(0.9, round2(x.extractionConfidence))) : null;
  const w = Array.isArray(x.warnings) ? x.warnings.filter((i) => typeof i === 'string').map((i) => i.slice(0, 200)).slice(0, 10) : [];
  return { method: 'vision', confidence: c, needsReview: true, issues: w, recipient: str(x.recipientDetails, 120), model: str(x.model, 80), edited: x.edited === true };
}

export const findDuplicateProof = (payments, hash, exceptId = null) => (hash ? payments.find((p) => p.id !== exceptId && p.status !== 'rejected' && p.proofHash === hash) ?? null : null);
export const duplicateProofError = (dup) => new ApiError(409, 'DUPLICATE_SCREENSHOT', `This screenshot has already been recorded${dup?.id ? ` (payment ${dup.id}, ${dup.status === 'confirmed' ? 'confirmed' : 'waiting for verification'})` : ''}. Open that payment instead of adding it twice.`, [{ field: 'proof', message: 'This exact screenshot is already attached to a payment.' }]);

// ---- Summaries ----------------------------------------------------------------------------------------------------------
// One order's money, from its payment records. Records that are pending or rejected never reduce the balance.
export function summarize(order, payments = []) {
  const live = payments.filter((p) => p.status !== 'rejected');
  const sum = (list) => round2(list.reduce((s, p) => s + p.amount, 0));
  const received = sum(live.filter((p) => p.kind === 'payment' && p.status === 'confirmed'));
  const refunded = sum(live.filter((p) => p.kind === 'refund' && p.status === 'confirmed'));
  const paid = round2(received - refunded);
  const pending = sum(live.filter((p) => p.kind === 'payment' && p.status === 'pending' && p.method !== 'cod'));
  const codDue = sum(live.filter((p) => p.kind === 'payment' && p.status === 'pending' && p.method === 'cod'));
  const total = typeof order.price === 'number' ? order.price : null;
  const balance = total === null ? null : Math.max(0, round2(total - paid));
  const recorded = payments.length > 0;

  let status;
  if (total !== null && paid > EPS && balance < EPS) status = 'paid';
  else if (pending > 0) status = 'verification_pending';
  else if (codDue > 0) status = 'cod';
  else if (paid > EPS) status = 'partial';
  else if (!recorded && order.paymentStatus === 'verified') status = 'paid'; // marked paid by hand, before payments were tracked
  else if (!recorded && order.paymentStatus === 'partial') status = 'partial';
  else status = 'due';
  return { total, paid, balance, pending, codDue, refunded, status, recorded, legacy: !recorded && ['verified', 'partial'].includes(order.paymentStatus) };
}

// The value of Order.paymentStatus that matches the records. With no records the owner's own setting is left alone.
export function orderPaymentStatus(order, payments) {
  if (payments.length === 0) return order.paymentStatus;
  const s = summarize(order, payments);
  if (s.status === 'paid') return 'verified';
  if (s.paid > EPS) return 'partial';
  if (s.pending > 0) return 'pending';
  if (s.codDue === 0 && payments.every((p) => p.status === 'rejected')) return 'rejected';
  return 'unverified';
}

// Three things are tracked apart and a screenshot only ever moves the first two: what was READ (extraction), whether it was MATCHED to an
// order (match), and whether the owner VERIFIED the money (status). Only the owner's confirmation produces 'verified'.
export function displayStatus(p) {
  if (p.status === 'rejected') return 'rejected';
  if (p.status === 'confirmed') return 'verified';
  if (!p.orderId || p.match?.reviewRequired || p.review?.mode === 'needs_review') return 'pending_review';
  return 'awaiting_verification';
}

export const toPublic = (p) => ({
  id: p.id, orderId: p.orderId ?? null, displayStatus: displayStatus(p), match: p.match ?? null, kind: p.kind ?? 'payment', amount: p.amount, method: p.method, status: p.status,
  transactionId: p.transactionId ?? null, paidAt: p.paidAt ? new Date(p.paidAt).toISOString() : null, source: p.source ?? 'manual', notes: p.notes ?? null,
  conversationId: p.conversationId ?? null, messageId: p.messageId ?? null,
  proof: p.proof ? { url: p.proof.url ?? `/payments/${p.id}/proof`, contentType: p.proof.contentType, size: p.proof.size ?? null } : null,
  extraction: p.extraction ?? null, review: p.review ?? null, refundOf: p.refundOf ?? null, history: p.history ?? [], isDemo: Boolean(p.isDemo),
  createdAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
});

// The ledger: every order with its payment summary and records, plus the four headline numbers, all computed from the records.
export function buildLedger(orders, payments) {
  const by = {};
  for (const p of payments) if (p.orderId) (by[p.orderId] ??= []).push(p);
  const unassigned = payments.filter((p) => !p.orderId && p.status !== 'rejected').sort((a, b) => new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0)).map(toPublic);
  const when = (p) => new Date(p.paidAt ?? p.createdAt ?? 0).getTime();
  const rows = orders.map((o) => {
    const list = (by[o.id] ?? []).slice().sort((a, b) => when(b) - when(a));
    const s = summarize(o, list);
    const latest = list.find((p) => p.status !== 'rejected' && p.kind === 'payment') ?? null;
    return {
      orderId: o.id, customerName: o.customerName, item: o.item, quantity: o.quantity ?? 1, orderStatus: o.status, deadline: o.deadline ?? null, isDemo: typeof o.notes === 'string' && o.notes.startsWith('[DEMO]'),
      ...s, method: latest?.method ?? null, reference: latest?.transactionId ?? null, paidAt: latest?.paidAt ? new Date(latest.paidAt).toISOString() : null, source: latest?.source ?? null,
      hasProof: list.some((p) => p.proof), toVerify: list.filter((p) => p.status === 'pending' && p.method !== 'cod').length,
      payments: list.map(toPublic),
    };
  }).sort((a, b) => Date.parse(b.paidAt ?? 0) - Date.parse(a.paidAt ?? 0) || a.customerName.localeCompare(b.customerName));

  const live = rows.filter((r) => r.orderStatus !== 'cancelled');
  const kpis = {
    totalReceived: round2(rows.reduce((s, r) => s + r.paid, 0)),
    outstanding: round2(live.reduce((s, r) => s + (r.balance ?? 0), 0)),
    outstandingOrders: live.filter((r) => (r.balance ?? 0) > EPS).length,
    partiallyPaid: live.filter((r) => r.paid > EPS && (r.balance ?? 0) > EPS).length,
    partialBalance: round2(live.filter((r) => r.paid > EPS).reduce((s, r) => s + (r.balance ?? 0), 0)),
    toVerify: rows.reduce((s, r) => s + r.toVerify, 0),
    toVerifyAmount: round2(rows.reduce((s, r) => s + r.pending, 0)),
    toReview: unassigned.length + rows.reduce((s, r) => s + r.payments.filter((p) => p.displayStatus === 'pending_review').length, 0),
    codDue: round2(rows.reduce((s, r) => s + r.codDue, 0)),
  };
  return { kpis, rows, unassigned };
}

// ---- Checks used before a write -----------------------------------------------------------------------------------------
export function findDuplicate(payments, key, exceptId = null) {
  if (!key) return null;
  return payments.find((p) => p.id !== exceptId && p.status !== 'rejected' && txnKey(p.transactionId) === key) ?? null;
}
export const duplicateError = (dup) => new ApiError(409, 'DUPLICATE_TRANSACTION', `Transaction ${dup.transactionId} is already recorded${dup.orderId ? ` (payment ${dup.id})` : ''}. Open that payment instead of adding it twice.`, [{ field: 'transactionId', message: 'This transaction ID has already been recorded.' }]);

// ---- One real transaction, one payment record ------------------------------------------------------------------------------------------
// A screenshot (or a payment read from one) that describes a transaction already on the order must not become a second record. These two pure
// functions decide that, and describe the update; the server and the browser demo both use them.
const SAME_PAYMENT_WINDOW_MS = 24 * 3600000; // two payments of the same amount and method this close together, with no reference to tell them apart

// The existing payment of `order` that `incoming` ({ key, amount, method, paidAt }) is the SAME transaction as, or null.
//   Same transaction reference                    -> the same transaction, always.
//   Different references                          -> separate transactions, always (never merged, whatever the amounts).
//   A reference missing on either side            -> the same transaction only when the amount and method match, the times are close, AND
//                                                    the existing record can still use the evidence (it has no screenshot, or it is still pending),
//                                                    or a second payment of that amount could not be real (it would pay the order more than its total).
export function findSameTransaction(payments, { key = null, amount, method, paidAt = null }, order = null) {
  const live = payments.filter((p) => p.status !== 'rejected' && p.kind !== 'refund');
  if (key) { const hit = live.find((p) => txnKey(p.transactionId) === key); if (hit) return hit; }
  const total = typeof order?.price === 'number' ? order.price : null;
  const committed = round2(live.filter((p) => p.method !== 'cod' || p.status === 'confirmed').reduce((n, p) => n + p.amount, 0));
  const overpays = total !== null && committed + amount - total > EPS;
  return live.find((p) => {
    const theirs = txnKey(p.transactionId);
    if (key && theirs) return false; // both have a reference and they differ
    if (Math.abs(p.amount - amount) >= EPS || p.method !== method) return false;
    if (p.paidAt && paidAt && Math.abs(new Date(p.paidAt) - new Date(paidAt)) > SAME_PAYMENT_WINDOW_MS) return false;
    return !p.proof || p.status === 'pending' || overpays;
  }) ?? null;
}

// What a screenshot of an already-recorded transaction changes on that record. The owner's confirmation is never undone and a confirmed amount is
// never rewritten: a confirmed payment only gains the screenshot (and a reference it lacked). A pending one takes the newer reading and stays pending,
// since only the owner verifies. Returns { set, mode, note, attachProof }; `mode` is what the owner is told.
export function reconcilePatch(existing, incoming) {
  const confirmed = existing.status === 'confirmed';
  const wantsProof = Boolean(incoming.hasProof) && !existing.proof;
  const set = {};
  if (!existing.transactionId && incoming.transactionId) Object.assign(set, { transactionId: incoming.transactionId, transactionKey: txnKey(incoming.transactionId) });
  if (!confirmed) {
    if (incoming.transactionId) Object.assign(set, { transactionId: incoming.transactionId, transactionKey: txnKey(incoming.transactionId) });
    if (incoming.amount !== undefined && Math.abs(existing.amount - incoming.amount) >= EPS) set.amount = round2(incoming.amount);
    if (incoming.paidAt && !existing.paidAt) set.paidAt = incoming.paidAt;
    if (incoming.extraction) set.extraction = incoming.extraction;
  }
  const changed = Object.keys(set).length > 0;
  const mode = wantsProof || changed ? (confirmed ? 'proof_added' : 'updated') : 'already_recorded';
  const note = mode === 'already_recorded' ? 'The same transaction was uploaded again; no new record was made.'
    : confirmed ? 'The screenshot was added to this payment. Nothing about the confirmation changed.' : 'Updated from a screenshot of the same transaction. Still waiting for the owner to verify.';
  return { set, mode, note, attachProof: wantsProof };
}

// Confirm: the owner has checked their account and says this money arrived. Nothing is verified with a bank.
export function validateConfirm(body, payment, summary) {
  const details = [];
  if (!isPlainObject(body)) throw validationError([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  if (payment.status !== 'pending') throw new ApiError(409, 'CONFLICT', `This payment is already ${payment.status}.`);
  if (payment.kind === 'refund') throw new ApiError(409, 'CONFLICT', 'Refunds are recorded as confirmed and cannot be confirmed again.');
  if (body.acknowledged !== true) details.push({ field: 'acknowledged', message: 'Confirm that you have checked the amount and transaction in your own account.' });
  if (typeof body.reviewer !== 'string' || !body.reviewer.trim() || body.reviewer.trim().length > 80) details.push({ field: 'reviewer', message: 'Enter your name so the confirmation is recorded.' });
  const amount = body.amount === undefined ? payment.amount : body.amount;
  if (!money(amount)) details.push({ field: 'amount', message: 'Enter the amount that actually arrived (above 0, at most 2 decimals).' });
  let txn = payment.transactionId ?? null;
  if (body.transactionId !== undefined) {
    if (body.transactionId === null || body.transactionId === '') txn = null;
    else if (typeof body.transactionId !== 'string' || !TXN.test(body.transactionId.trim())) details.push({ field: 'transactionId', message: 'Use 4–64 letters, numbers, dashes or slashes.' });
    else txn = body.transactionId.trim();
  }
  if (payment.method !== 'cod' && payment.method !== 'cash' && !txn && body.noReference !== true) details.push({ field: 'transactionId', message: 'Enter the transaction ID, or tick “No reference available”.' });
  if (details.length) throw validationError(details);
  const owed = summary.balance;
  if (owed !== null && round2(amount) - owed > EPS) {
    throw new ApiError(422, 'EXCEEDS_BALANCE', `This would record ${round2(amount)} against a remaining balance of ${owed}. Lower the amount, or fix the order total first.`, [{ field: 'amount', message: `At most ${owed} can be confirmed for this order.` }]);
  }
  return { amount: round2(amount), transactionId: txn, reviewer: body.reviewer.trim(), note: typeof body.note === 'string' ? body.note.trim().slice(0, 500) || null : null };
}

export function validateReject(body) {
  if (!isPlainObject(body)) throw validationError([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details = [];
  if (!['reject', 'needs_review'].includes(body.mode)) details.push({ field: 'mode', message: 'Must be reject or needs_review.' });
  if (typeof body.reviewer !== 'string' || !body.reviewer.trim() || body.reviewer.trim().length > 80) details.push({ field: 'reviewer', message: 'Enter your name so this is recorded.' });
  if (body.note !== undefined && body.note !== null && (typeof body.note !== 'string' || body.note.length > 500)) details.push({ field: 'note', message: 'Up to 500 characters.' });
  if (body.mode === 'reject' && !(typeof body.note === 'string' && body.note.trim())) details.push({ field: 'note', message: 'Say briefly why it is rejected.' });
  if (details.length) throw validationError(details);
  return { mode: body.mode, reviewer: body.reviewer.trim(), note: typeof body.note === 'string' ? body.note.trim() || null : null };
}

// Refund or reversal of a confirmed payment. The original is never edited; a second, negative-effect record is added.
export function validateRefund(body, original, existing) {
  if (!isPlainObject(body)) throw validationError([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  if (original.kind !== 'payment' || original.status !== 'confirmed') throw new ApiError(409, 'CONFLICT', 'Only a confirmed payment can be refunded.');
  const details = [];
  const already = round2(existing.filter((p) => p.kind === 'refund' && p.refundOf === original.id && p.status === 'confirmed').reduce((s, p) => s + p.amount, 0));
  const left = round2(original.amount - already);
  if (!money(body.amount)) details.push({ field: 'amount', message: 'Enter the amount refunded (above 0, at most 2 decimals).' });
  else if (round2(body.amount) - left > EPS) details.push({ field: 'amount', message: `At most ${left} of this payment can still be refunded.` });
  if (typeof body.reviewer !== 'string' || !body.reviewer.trim() || body.reviewer.trim().length > 80) details.push({ field: 'reviewer', message: 'Enter your name so this is recorded.' });
  if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 500) details.push({ field: 'reason', message: 'Say why it is being refunded or reversed.' });
  if (details.length) throw validationError(details);
  return { amount: round2(body.amount), reviewer: body.reviewer.trim(), reason: body.reason.trim() };
}

// ---- Automatic detection: matching and duplicates -----------------------------------------------------------------------
const digits = (v) => String(v ?? '').replace(/\D/g, '');
const sameNumber = (a, b) => { const x = digits(a); const y = digits(b); return x.length >= 7 && y.length >= 7 && x.slice(-10) === y.slice(-10); };
const sameName = (a, b) => { const n = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' '); return n(a).length > 1 && n(a) === n(b); };

// Which order does a screenshot belong to? Pure, so it is tested on its own.
//  conv: { orderId, customerName, contactId }   orders: [{ id, customerName, customerContact, status, balance }]   amount: number
// 'matched'   the chat is linked to the order, or the sender's own phone number picks out exactly one open order. The order is set.
// 'uncertain' something points at an order but not firmly enough (name only, several candidates, amount above the balance). No order is set
//             unless the chat itself is linked; the candidates are suggested and the owner decides.
// 'unmatched' nothing fits. The record waits, with no order, until the owner assigns one.
export function matchOrder(conv, orders, amount) {
  const open = orders.filter((o) => o.status !== 'cancelled');
  const fits = (o) => o.balance === null || o.balance === undefined || amount - o.balance <= EPS;
  if (conv.orderId) {
    const o = open.find((x) => x.id === String(conv.orderId));
    if (!o) return { state: 'unmatched', orderId: null, candidates: [], reason: 'This chat is linked to an order that is cancelled or no longer exists.' };
    return fits(o) ? { state: 'matched', orderId: o.id, candidates: [o.id], reason: 'The chat is linked to this order.' }
      : { state: 'uncertain', orderId: o.id, candidates: [o.id], reason: `The amount is more than the ${o.balance} still owed on the linked order.` };
  }
  const due = open.filter((o) => o.balance === null || o.balance === undefined || o.balance > EPS);
  const byPhone = due.filter((o) => sameNumber(o.customerContact, conv.contactId));
  const byName = due.filter((o) => sameName(o.customerName, conv.customerName));
  const pool = byPhone.length ? byPhone : byName;
  const via = byPhone.length ? 'phone number' : 'customer name';
  if (pool.length === 0) return { state: 'unmatched', orderId: null, candidates: [], reason: 'No open order was found for this customer.' };
  const exact = pool.filter((o) => o.balance !== null && o.balance !== undefined && Math.abs(o.balance - amount) <= EPS);
  const pick = pool.length === 1 ? pool[0] : exact.length === 1 ? exact[0] : null;
  if (!pick) return { state: 'uncertain', orderId: null, candidates: pool.map((o) => o.id), reason: `${pool.length} open orders fit this customer. Choose the right one.` };
  if (via === 'customer name') return { state: 'uncertain', orderId: null, candidates: [pick.id], reason: 'Matched by customer name only, which is not firm enough to assign automatically.' };
  if (!fits(pick)) return { state: 'uncertain', orderId: null, candidates: [pick.id], reason: `The amount is more than the ${pick.balance} still owed on the matching order.` };
  return { state: 'matched', orderId: pick.id, candidates: [pick.id], reason: `Matched by the sender's phone number${pool.length > 1 ? ' and the amount' : ''}.` };
}

// Why a record needs a person to look at it before anyone relies on it. An empty list means it can wait in the normal verification queue.
export function reviewReasons({ x, match, hasMethod }) {
  const why = [];
  if (match.state !== 'matched') why.push(match.reason);
  if (x.confidence < LOW_CONFIDENCE) why.push(`Low reading confidence (${Math.round(x.confidence * 100)}%).`);
  if (!x.transactionId) why.push('No transaction ID could be read.');
  if (!hasMethod) why.push('The payment method could not be read.');
  if (x.succeeded === false) why.push('The screenshot may show a failed or pending payment.');
  return why;
}

// An identifier-based duplicate check across ALL orders: same transaction ID, else same amount + method at the same minute.
export function findPossibleDuplicate(payments, { key, amount, method, paidAt }) {
  const live = payments.filter((p) => p.status !== 'rejected' && p.kind !== 'refund');
  if (key) { const hit = live.find((p) => txnKey(p.transactionId) === key); if (hit) return hit; }
  if (paidAt) return live.find((p) => p.paidAt && Math.abs(amount - p.amount) < EPS && p.method === method && Math.abs(new Date(p.paidAt) - new Date(paidAt)) <= 60000) ?? null;
  return null;
}

// The whole decision for one payment screenshot that has been read: duplicate, or a pending record (with its match) that is either
// ready for verification ('filed') or needs a person first ('review'). Pure, so the server pipeline, the demo seed and the browser demo
// all make the same call. `x` is the reading (see toReading); `existing` are the payments already on file; `orders` the candidates.
export function decideDetectedPayment({ x, succeeded = true, conv, orders, existing, receivedAt, manual = false, now = new Date() }) {
  const match = matchOrder(conv, orders, x.amount);
  const paidAt = x.paymentDate && new Date(x.paymentDate) <= now ? new Date(x.paymentDate) : null;
  const key = txnKey(x.transactionId);
  const method = x.paymentMethod ?? 'other';
  const same = findPossibleDuplicate(existing, { key, amount: x.amount, method, paidAt });
  if (same) return { state: 'duplicate', reason: `This payment is already recorded${x.transactionId ? ` (transaction ${x.transactionId})` : ''}.`, duplicate: same };
  const why = reviewReasons({ x: { confidence: x.extractionConfidence, transactionId: x.transactionId, succeeded }, match, hasMethod: Boolean(x.paymentMethod) });
  const lowConfidence = why.some((w) => /confidence|failed or pending/.test(w));
  const issues = [...x.warnings, ...(paidAt ? [] : ['No usable payment date; the message time is used.'])];
  return {
    state: why.length ? 'review' : 'filed', reason: why.length ? why.join(' ') : null,
    record: {
      orderId: match.orderId, amount: round2(x.amount), method, status: 'pending', transactionId: x.transactionId ?? null, transactionKey: key, paidAt: paidAt ?? receivedAt,
      source: manual ? 'chat_screenshot' : 'auto_screenshot', notes: 'Read from a screenshot in Messages. Not yet verified.',
      extraction: { method: 'vision', confidence: x.extractionConfidence, needsReview: true, issues, recipient: x.recipientDetails ?? null, model: x.model ?? null, extractedAt: now },
      match: { state: match.state, by: 'auto', reason: match.reason, candidates: match.candidates, reviewRequired: why.length > 0, lowConfidence, auto: !manual },
    },
  };
}
