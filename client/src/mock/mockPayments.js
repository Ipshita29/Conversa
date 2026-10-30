// The in-browser DEMO payments backend. It runs the SAME rules as the server (server/services/paymentLogic.js and paymentExtraction.js),
// on in-memory records that reset on reload. Nothing here talks to a bank, WhatsApp or any server, and no screenshot leaves the browser.
import { ApiError } from '../services/api.js';
import { buildDemoPayments } from '../../../server/scripts/demo-data.js';
import {
  buildLedger, summarize, orderPaymentStatus, toPublic, txnKey, findDuplicate, duplicateError,
  validatePaymentInput, validateConfirm, validateReject, validateRefund, findDuplicateProof, duplicateProofError,
} from '../../../server/services/paymentLogic.js';
import { parsePaymentText } from '../../../server/services/paymentExtraction.js';

const iso = (d) => (d ? new Date(d).toISOString() : null);
const invalid = (details) => new ApiError(422, 'VALIDATION_ERROR', 'Request validation failed.', details);

// A clearly fake receipt for the screenshot-extracted demo payment.
const receipt = (amount, txn) => `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="640" viewBox="0 0 360 640"><rect width="360" height="640" fill="#F7F4ED"/><rect x="24" y="60" width="312" height="500" rx="24" fill="#fff" stroke="#E4E0D8"/>`
  + `<circle cx="180" cy="130" r="30" fill="#E4EEDF"/><path d="M165 130l10 10 20-22" stroke="#3E6A3D" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
  + `<text x="180" y="200" font-family="Arial" font-size="15" fill="#62584F" text-anchor="middle">Payment successful</text>`
  + `<text x="180" y="248" font-family="Arial" font-size="38" font-weight="700" fill="#292923" text-anchor="middle">₹${amount.toLocaleString('en-IN')}</text>`
  + `<text x="48" y="320" font-family="Arial" font-size="12" fill="#9A9288">To</text><text x="48" y="342" font-family="Arial" font-size="15" fill="#292923">S***** C****** (name partly hidden)</text>`
  + `<text x="48" y="392" font-family="Arial" font-size="12" fill="#9A9288">UPI transaction ID</text><text x="48" y="414" font-family="Arial" font-size="15" fill="#292923">${txn}</text>`
  + `<text x="48" y="464" font-family="Arial" font-size="12" fill="#9A9288">Time</text><text x="48" y="486" font-family="Arial" font-size="15" fill="#292923">blurred</text>`
  + `<rect x="48" y="530" width="264" height="1" fill="#E4E0D8"/><text x="180" y="610" font-family="Arial" font-size="11" fill="#B8B1A5" text-anchor="middle">DEMO IMAGE · not a real receipt</text></svg>`)}`;

// SHA-256 of an image, as the server computes it: the same screenshot is the same record, whichever page it comes through.
const sha256 = async (file) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('');

export function createMockPayments(getOrders, getConversations = () => []) {
  let n = 0;
  const nextId = () => `pay_${++n}`;
  const stamp = (p) => ({ ...p, id: p.id ?? nextId(), createdAt: p.createdAt ?? iso(p.paidAt ?? new Date()), transactionKey: txnKey(p.transactionId) });
  let list = buildDemoPayments(getOrders().map((o) => ({ ...o, id: o.id })), new Date()).map(stamp)
    .map((p) => (p.source === 'chat_screenshot' ? { ...p, proof: { url: receipt(p.amount, p.transactionId), contentType: 'image/svg+xml', size: null } } : p));
  const proofs = new Map();

  const orderOf = (id) => getOrders().find((o) => o.id === id) ?? null;
  const need = (id) => { const o = orderOf(id); if (!o) throw new ApiError(404, 'NOT_FOUND', `Order '${id}' not found.`); return o; };
  const find = (id) => { const p = list.find((x) => x.id === id); if (!p) throw new ApiError(404, 'NOT_FOUND', `Payment '${id}' not found.`); return p; };
  const ofOrder = (oid) => list.filter((p) => p.orderId === oid);
  const hist = (action, by, note) => ({ at: iso(new Date()), action, by: by ?? null, note: note ?? null });
  const sync = (oid) => { const o = orderOf(oid); if (o) o.paymentStatus = orderPaymentStatus(o, ofOrder(oid)); };
  list.forEach((p) => sync(p.orderId));
  const withUrl = (p) => (p.proof ? { ...p, proof: { ...p.proof, url: p.proof.url ?? proofs.get(p.id) } } : p);
  const pub = (p) => toPublic(withUrl(p));
  const detail = (p) => { const o = orderOf(p.orderId); return { payment: pub(p), order: { id: o.id, customerName: o.customerName, item: o.item, quantity: o.quantity, price: o.price ?? null, status: o.status }, summary: summarize(o, ofOrder(o.id)) }; };

  function create(body, { source = 'manual', extra = {}, proofHash = null } = {}) {
    const { value, details } = validatePaymentInput(body);
    if (details.length) throw invalid(details);
    if (value.extraction && source === 'manual') { source = 'screenshot_upload'; extra = { extraction: { ...value.extraction, extractedAt: iso(new Date()) }, ...extra }; }
    const dupProof = findDuplicateProof(list, proofHash);
    if (dupProof) throw duplicateProofError(dupProof);
    const order = need(value.orderId);
    if (order.status === 'cancelled') throw new ApiError(409, 'CONFLICT', 'This order is cancelled, so no payment can be recorded against it.');
    const key = txnKey(value.transactionId);
    const dup = findDuplicate(list, key);
    if (dup) throw duplicateError(dup);
    const sum = summarize(order, ofOrder(order.id));
    if ((value.method === 'cod' || value.confirmed) && sum.balance !== null && value.amount - sum.balance > 0.005) {
      throw new ApiError(422, 'EXCEEDS_BALANCE', `This would record ${value.amount} against a remaining balance of ${sum.balance}.`, [{ field: 'amount', message: `At most ${sum.balance}.` }]);
    }
    const now = new Date();
    const p = stamp({
      orderId: order.id, kind: 'payment', amount: value.amount, method: value.method, transactionId: value.transactionId ?? null, paidAt: iso(value.paidAt ?? (value.method === 'cod' ? null : now)),
      status: value.confirmed ? 'confirmed' : 'pending', source, notes: value.notes ?? null, isDemo: false, createdAt: iso(now), proofHash,
      review: value.confirmed ? { by: value.reviewer, at: iso(now), confirmedAmount: value.amount, mode: 'manual_entry', note: 'Entered by the owner as already received.' } : null,
      history: [hist(source === 'manual' ? 'recorded' : 'extracted', value.confirmed ? value.reviewer : null, value.confirmed ? 'Recorded as received by the owner.' : 'Waiting for the owner to verify.'), ...(value.confirmed ? [hist('confirmed', value.reviewer, 'Owner confirmed the money arrived (manual check).')] : [])],
      ...extra,
    });
    list = [p, ...list];
    sync(order.id);
    return p;
  }

  async function dataUrl(file) {
    return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error('Could not read the file.')); r.readAsDataURL(file); });
  }
  const checkFile = (file) => {
    if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new ApiError(415, 'UNSUPPORTED_MEDIA', 'Upload a PNG, JPEG or WebP image.');
    if (file.size > 5 * 1024 * 1024) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'The image is larger than 5 MB.');
  };

  // Files a screenshot the REAL server has read (read-image) as a pending payment on a demo order. The browser never reads or invents
  // the extraction: without one (the server was unreachable or could not read it) nothing is filed.
  async function fileFromReading(body) {
    checkFile(body.file);
    need(body.orderId);
    const x = body.extraction;
    if (!x || !(x.amount > 0)) throw new ApiError(422, 'EXTRACTION_FAILED', 'No payment amount could be read from this image. Enter the payment by hand and keep the screenshot attached.');
    const hash = await sha256(body.file);
    const paid = x.paymentDate && new Date(x.paymentDate) <= new Date() ? x.paymentDate : undefined;
    const rec = create({ orderId: body.orderId, amount: x.amount, method: x.paymentMethod ?? 'other', transactionId: x.transactionId ?? undefined, paidAt: paid, notes: 'Read from a screenshot. Not yet verified.' },
      { source: 'chat_screenshot', proofHash: hash, extra: { conversationId: body.conversationId ?? null, messageId: body.messageId ?? null, extraction: { method: 'vision', confidence: x.extractionConfidence, needsReview: true, issues: x.warnings ?? [], recipient: x.recipientDetails ?? null, model: x.model ?? null, extractedAt: iso(new Date()) } } });
    proofs.set(rec.id, await dataUrl(body.file)); rec.proof = { contentType: body.file.type, size: body.file.size }; rec.history.push(hist('proof_added', null, 'Screenshot kept as received.'));
    return { payment: pub(rec), extraction: x };
  }

  return async function handle(method, p, body = {}) {
    let m;
    if (method === 'GET' && p === '/payments') return buildLedger(getOrders(), list.map(withUrl));
    if (method === 'POST' && p === '/payments') {
      if (body.file) checkFile(body.file);
      const hash = body.file ? await sha256(body.file) : null;
      const rec = create(body.payment ?? body, { proofHash: hash });
      if (body.file) { proofs.set(rec.id, await dataUrl(body.file)); rec.proof = { contentType: body.file.type, size: body.file.size }; rec.history.push(hist('proof_added', null, 'Screenshot attached.')); }
      return pub(rec);
    }
    if (method === 'POST' && p === '/payments/check-proof') { // demo mode: is this exact image already filed in the browser's demo data?
      checkFile(body.file);
      const dup = findDuplicateProof(list, await sha256(body.file));
      return { duplicate: dup ? { id: dup.id, status: dup.status, orderId: dup.orderId } : null };
    }
    if (method === 'POST' && p === '/payments/extract') {
      const x = parsePaymentText(body.message);
      const extraction = { isPayment: x.isPayment, amount: x.amount, transactionId: x.transactionId, method: x.method, confidence: x.confidence, issues: x.issues };
      if (!x.isPayment) return { payment: null, extraction, reason: 'This message does not look like a payment.' };
      if (!body.orderId) return { payment: null, extraction, reason: 'Link this chat to an order first, so the payment goes to the right one.' };
      if (x.amount === null) return { payment: null, extraction, reason: 'No amount was found. Record the payment by hand and the details will be kept for review.' };
      const rec = create({ orderId: body.orderId, amount: x.amount, method: x.method ?? 'other', transactionId: x.transactionId ?? undefined, notes: 'Read from a chat message. Not yet verified.' },
        { source: 'chat_text', extra: { conversationId: body.conversationId ?? null, messageId: body.messageId ?? null, extraction: { method: 'text', confidence: x.confidence, needsReview: true, issues: x.issues, recipient: null, model: 'rules', extractedAt: iso(new Date()) } } });
      return { payment: pub(rec), extraction, reason: null };
    }
    if (method === 'POST' && p === '/payments/extract-image') return fileFromReading(body);
    if ((m = p.match(/^\/conversations\/([^/]+)\/attachments$/)) && method === 'POST') {
      checkFile(body.file);
      const conv = getConversations().find((c) => c.id === m[1]);
      if (!conv) throw new ApiError(404, 'NOT_FOUND', `Conversation '${m[1]}' not found.`);
      const msg = { id: `m_up_${++n}_${Date.now()}`, from: 'customer', text: null, at: iso(new Date()), read: false, attachment: { url: await dataUrl(body.file), contentType: body.file.type }, payment: null };
      conv.messages.push(msg); conv.unread = (conv.unread ?? 0) + 1;
      return msg;
    }
    if ((m = p.match(/^\/conversations\/([^/]+)\/messages\/([^/]+)\/extract-payment$/)) && method === 'POST') {
      const conv = getConversations().find((c) => c.id === m[1]);
      const msg = conv?.messages.find((x) => x.id === m[2]);
      if (!msg?.attachment) throw new ApiError(404, 'NOT_FOUND', 'That message has no picture to read.');
      if (msg.payment) return { payment: pub(find(msg.payment.id)), extraction: null, existing: true }; // asked twice: the payment already filed
      if (!conv.orderId) throw new ApiError(409, 'CONFLICT', 'Link this chat to an order first, so the payment goes to the right one.');
      const r = await fileFromReading({ ...body, orderId: conv.orderId, conversationId: conv.id, messageId: msg.id });
      msg.payment = { id: r.payment.id, status: r.payment.status, amount: r.payment.amount, method: r.payment.method, transactionId: r.payment.transactionId };
      return { ...r, existing: false };
    }
    if ((m = p.match(/^\/payments\/([^/]+)$/)) && method === 'GET') return detail(find(m[1]));
    if ((m = p.match(/^\/payments\/([^/]+)\/(confirm|reject|refund|proof)$/)) && method === 'POST') {
      const pay = find(m[1]);
      const order = need(pay.orderId);
      if (m[2] === 'proof') {
        checkFile(body.file);
        if (pay.proof) throw new ApiError(409, 'CONFLICT', 'This payment already has a screenshot.');
        const hash = await sha256(body.file); const dup = findDuplicateProof(list, hash, pay.id); if (dup) throw duplicateProofError(dup);
        proofs.set(pay.id, await dataUrl(body.file)); pay.proof = { contentType: body.file.type, size: body.file.size }; pay.proofHash = hash; pay.history.push(hist('proof_added', null, 'Screenshot attached.'));
        return pub(pay);
      }
      if (m[2] === 'confirm') {
        const v = validateConfirm(body, pay, summarize(order, ofOrder(order.id).filter((x) => x.id !== pay.id)));
        const key = txnKey(v.transactionId);
        const dup = findDuplicate(list, key, pay.id);
        if (dup) throw duplicateError(dup);
        const now = iso(new Date());
        Object.assign(pay, { status: 'confirmed', amount: v.amount, transactionId: v.transactionId, transactionKey: key, paidAt: pay.paidAt ?? now, review: { by: v.reviewer, at: now, note: v.note, confirmedAmount: v.amount, mode: 'confirmed' } });
        pay.history.push(hist('confirmed', v.reviewer, `Owner confirmed ${v.amount} arrived. Checked manually; not verified with a bank.`));
      } else if (m[2] === 'reject') {
        const v = validateReject(body);
        if (pay.status !== 'pending') throw new ApiError(409, 'CONFLICT', `This payment is already ${pay.status}.`);
        const review = { by: v.reviewer, at: iso(new Date()), note: v.note, mode: v.mode === 'reject' ? 'rejected' : 'needs_review' };
        if (v.mode === 'reject') Object.assign(pay, { status: 'rejected', review });
        else Object.assign(pay, { review, extraction: { ...(pay.extraction ?? { method: 'manual', confidence: null }), needsReview: true, issues: [...(pay.extraction?.issues ?? []), ...(v.note ? [v.note] : [])] } });
        pay.history.push(hist(v.mode === 'reject' ? 'rejected' : 'needs_review', v.reviewer, v.note));
      } else {
        const v = validateRefund(body, pay, ofOrder(order.id));
        const now = iso(new Date());
        list = [stamp({ orderId: order.id, kind: 'refund', refundOf: pay.id, amount: v.amount, method: pay.method, status: 'confirmed', paidAt: now, source: 'manual', notes: v.reason, review: { by: v.reviewer, at: now, confirmedAmount: v.amount, mode: 'refund', note: v.reason }, history: [hist('refunded', v.reviewer, v.reason)], isDemo: false }), ...list];
        pay.history.push(hist('refund_recorded', v.reviewer, `${v.amount} refunded: ${v.reason}`));
      }
      sync(order.id);
      return detail(pay);
    }
    throw new ApiError(404, 'NOT_FOUND', `Demo API has no route ${method} ${p}.`);
  };
}
