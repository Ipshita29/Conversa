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
export const PAYMENT_SOURCES = ['manual', 'chat_text', 'chat_screenshot', 'screenshot_upload'];
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

export const toPublic = (p) => ({
  id: p.id, orderId: p.orderId, kind: p.kind ?? 'payment', amount: p.amount, method: p.method, status: p.status,
  transactionId: p.transactionId ?? null, paidAt: p.paidAt ? new Date(p.paidAt).toISOString() : null, source: p.source ?? 'manual', notes: p.notes ?? null,
  conversationId: p.conversationId ?? null, messageId: p.messageId ?? null,
  proof: p.proof ? { url: p.proof.url ?? `/payments/${p.id}/proof`, contentType: p.proof.contentType, size: p.proof.size ?? null } : null,
  extraction: p.extraction ?? null, review: p.review ?? null, refundOf: p.refundOf ?? null, history: p.history ?? [], isDemo: Boolean(p.isDemo),
  createdAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
});

// The ledger: every order with its payment summary and records, plus the four headline numbers, all computed from the records.
export function buildLedger(orders, payments) {
  const by = {};
  for (const p of payments) (by[p.orderId] ??= []).push(p);
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
    codDue: round2(rows.reduce((s, r) => s + r.codDue, 0)),
  };
  return { kpis, rows };
}

// ---- Checks used before a write -----------------------------------------------------------------------------------------
export function findDuplicate(payments, key, exceptId = null) {
  if (!key) return null;
  return payments.find((p) => p.id !== exceptId && p.status !== 'rejected' && txnKey(p.transactionId) === key) ?? null;
}
export const duplicateError = (dup) => new ApiError(409, 'DUPLICATE_TRANSACTION', `Transaction ${dup.transactionId} is already recorded${dup.orderId ? ` (payment ${dup.id})` : ''}. Open that payment instead of adding it twice.`, [{ field: 'transactionId', message: 'This transaction ID has already been recorded.' }]);

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
