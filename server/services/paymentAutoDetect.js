// Automatic payment detection for pictures that arrive in Messages. For one image message it: reads the picture (the same Groq Vision
// service the manual flows use), decides whether it is a payment screenshot, matches it to a customer's order, refuses duplicates and
// files a Payment. What it files is only ever a CLAIM: status stays 'pending' (never verified), and anything doubtful is flagged
// for review or left without an order instead of being guessed. It never throws; the outcome is written on the message (paymentScan).
import Message from '../models/Message.js';
import Conversation from '../models/Conversation.js';
import Order from '../models/Order.js';
import Payment from '../models/Payment.js';
import { readProof } from './proofStore.js';
import { visionRead, toReading, recordExtraction, existingByHash, historyEntry, syncOrder } from './paymentService.js';
import { summarize, decideDetectedPayment, txnKey } from './paymentLogic.js';

const plain = (d) => d.toJSON();

async function setScan(id, state, reason = null, extra = {}) {
  await Message.updateOne({ _id: id }, { $set: { 'paymentScan.state': state, 'paymentScan.reason': reason, 'paymentScan.at': new Date(), ...extra } });
  return { state, reason };
}

// Open orders that could belong to this sender, each with what is still owed. Only the sender's own number or name selects candidates.
async function candidateOrders(conv) {
  const digits = String(conv.contactId ?? '').replace(/\D/g, '');
  const tail = digits.length >= 7 ? digits.slice(-10) : null;
  const name = conv.customerName?.trim();
  const or = [
    ...(conv.orderId ? [{ _id: conv.orderId }] : []),
    ...(tail ? [{ customerContact: { $regex: `${tail.split('').join('\\D*')}\\D*$` } }] : []),
    ...(name ? [{ customerName: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } }] : []),
  ];
  if (!or.length) return [];
  const orders = (await Order.find({ $or: or, status: { $ne: 'cancelled' } }).limit(50)).map(plain);
  const pays = (await Payment.find({ order: { $in: orders.map((o) => o.id) } })).map((p) => ({ ...p.toJSON(), proof: null }));
  return orders.map((o) => ({ id: o.id, customerName: o.customerName, customerContact: o.customerContact, status: o.status, balance: summarize(o, pays.filter((p) => p.orderId === o.id)).balance }));
}

// Handles one image message. manual = the owner pressed "Try again": same pipeline, but the record is not labelled as automatic.
// `read` replaces the vision call (demo screenshots use a preset reading, so the demo needs no API key); it returns what visionRead returns.
export async function processMessageImage(messageId, { manual = false, read = visionRead } = {}) {
  try {
    const claimed = await Message.findOneAndUpdate({ _id: messageId, 'paymentScan.state': 'processing', 'paymentScan.claimedAt': null }, { $set: { 'paymentScan.claimedAt': new Date() } }, { returnDocument: 'after' });
    if (!claimed) return { state: 'skipped', reason: 'Already handled.' }; // a duplicate trigger, or someone else is on it
    if (!claimed.attachment) return setScan(messageId, 'failed', 'The picture was not saved, so it could not be checked.');
    const buffer = await readProof(claimed.attachment);
    if (!buffer) return setScan(messageId, 'failed', 'The picture could not be read back from storage.');

    // The same image can arrive twice (forwarded again, sent under a new message id). One image is one payment.
    const sameImage = await existingByHash(claimed.attachment.sha256);
    if (sameImage) { await Message.updateOne({ _id: messageId }, { $set: { paymentId: sameImage.id } }); return setScan(messageId, 'duplicate', 'This screenshot was already recorded.'); }

    let v;
    try { v = await read(buffer, claimed); } catch (e) { return setScan(messageId, 'failed', e.message || 'The screenshot could not be read.'); }
    if (!v.isPaymentScreenshot) return setScan(messageId, 'not_payment', 'Not a payment screenshot.');
    if (v.amount === null) return setScan(messageId, 'failed', 'This looks like a payment screenshot, but the amount could not be read. Record it by hand.');
    const x = toReading(v);

    const conv = (await Conversation.findById(claimed.conversation)).toObject();
    const key = txnKey(x.transactionId);
    const paidAt = x.paymentDate && new Date(x.paymentDate) <= new Date() ? new Date(x.paymentDate) : null;
    const existing = (await Payment.find({ $or: [...(key ? [{ transactionKey: key }] : []), ...(paidAt ? [{ amount: x.amount, paidAt }] : [])] })).map((p) => p.toJSON());
    const d = decideDetectedPayment({ x, succeeded: v.succeeded, conv: { orderId: conv.orderId ? String(conv.orderId) : null, customerName: conv.customerName, contactId: conv.contactId }, orders: await candidateOrders(conv), existing, receivedAt: claimed.receivedAt, manual });
    if (d.state === 'duplicate') { await Message.updateOne({ _id: messageId }, { $set: { paymentId: d.duplicate.id } }); return setScan(messageId, 'duplicate', d.reason); }
    const { orderId: match, ...rec } = d.record;
    let doc;
    try {
      doc = await Payment.create({
        ...rec, order: match, conversation: claimed.conversation, messageId: String(claimed._id), proof: { ...claimed.attachment.toObject(), originalName: null }, proofHash: claimed.attachment.sha256,
        isDemo: Boolean(claimed.isDemo),
        history: [historyEntry('extracted', null, `Read from a screenshot in Messages${manual ? '' : ' automatically'}. ${match ? '' : 'No order matched yet. '}Waiting for review and verification.`)],
      });
    } catch (e) {
      if (e.code === 11000) { const dup = await existingByHash(claimed.attachment.sha256); if (dup) await Message.updateOne({ _id: messageId }, { $set: { paymentId: dup.id } }); return setScan(messageId, 'duplicate', 'This payment is already recorded.'); }
      throw e;
    }
    const orderId = match;
    if (orderId) await syncOrder(orderId);
    await Message.updateOne({ _id: messageId }, { $set: { paymentId: doc._id } });
    return { ...(await setScan(messageId, d.state, d.reason)), payment: doc };
  } catch (e) {
    console.error('[payments] automatic detection failed:', e.message);
    try { return await setScan(messageId, 'failed', 'Something went wrong while checking this picture. Try again, or record the payment by hand.'); } catch { return { state: 'failed', reason: e.message }; }
  }
}

// Fire-and-forget from the webhook, which must answer Meta quickly. idle() lets tests (and shutdown) wait for the work to finish.
const inflight = new Set();
export function queueScan(messageId) {
  const job = processMessageImage(messageId).finally(() => inflight.delete(job));
  inflight.add(job);
  return job;
}
export const scansIdle = () => Promise.allSettled([...inflight]);

// "Try again" on a failed picture.
export async function retryScan(messageId) {
  await Message.updateOne({ _id: messageId, 'paymentScan.state': 'failed' }, { $set: { 'paymentScan.state': 'processing', 'paymentScan.claimedAt': null, 'paymentScan.reason': null } });
  return processMessageImage(messageId, { manual: true });
}
