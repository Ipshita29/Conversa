import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import Payment from '../models/Payment.js';
import crypto from 'node:crypto';
import { displayStatus } from './paymentLogic.js';
import { extractOrderSpec, imageKind } from './orderSpec.js';
import { draftFromIncoming, extractFromImage, publicPayment } from './paymentService.js';
import { saveProof, readProof } from './proofStore.js';
import { queueScan, retryScan } from './paymentAutoDetect.js';
import { downloadMedia } from './integrations/whatsappService.js';
import { ApiError, notFound } from '../utils/errors.js';

// Stores normalised inbound messages. The unique (channel, externalId) index makes webhook retries idempotent.
// Messages are only stored: no order is created and no LLM call is made until the seller asks for extraction.
export async function ingest(messages) {
  let stored = 0;
  let duplicates = 0;
  for (const m of messages) {
    const conv = await upsertConversation(m);
    try {
      const attachment = await fetchAttachment(m);
      // Every image is checked for a payment in the background. If the picture could not be downloaded, say so instead of staying silent.
      const paymentScan = m.messageType !== 'image' ? null : attachment ? { state: 'processing', at: new Date() } : { state: 'failed', reason: 'The picture could not be downloaded, so it was not checked for a payment.', at: new Date() };
      const msg = await Message.create({ conversation: conv._id, channel: m.channel, externalId: m.externalId, text: m.text, messageType: m.messageType, receivedAt: m.receivedAt, attachment, paymentScan });
      stored++;
      if (paymentScan?.state === 'processing') queueScan(msg._id);
      // A payment-looking message in a chat already linked to an order is filed as Verification pending (never as paid).
      await draftFromIncoming(conv, m.text, String(msg._id), m.receivedAt);
    } catch (err) {
      if (err.code === 11000) duplicates++;
      else throw err;
    }
  }
  return { stored, duplicates };
}

// A customer's picture (WhatsApp): downloaded with the server's own token and kept like a payment proof. Never fatal.
async function fetchAttachment(m) {
  try {
    if (m.channel !== 'whatsapp' || m.messageType !== 'image' || !m.mediaId) return null;
    const buf = await downloadMedia(m.mediaId);
    if (!buf) return null;
    const { file, contentType, size, sha256 } = await saveProof(buf, null);
    return { file, contentType, size, sha256 };
  } catch { return null; }
}

async function upsertConversation(m, retry = true) {
  const update = { $set: { lastMessageAt: m.receivedAt, ...(m.contactName ? { customerName: m.contactName } : {}) } };
  try {
    return await Conversation.findOneAndUpdate({ channel: m.channel, contactId: m.contactId }, update, { upsert: true, new: true });
  } catch (err) {
    if (err.code === 11000 && retry) return upsertConversation(m, false); // concurrent first message from same contact
    throw err;
  }
}

const shape = (c, msgs) => ({
  id: String(c._id), channel: c.channel, customerName: c.customerName || `Unknown (${c.contactId})`,
  ...(c.channel === 'whatsapp' ? { phone: c.isDemo ? null : c.contactId } : { handle: c.isDemo ? null : c.contactId }),
  orderId: c.orderId ? String(c.orderId) : null, isDemo: Boolean(c.isDemo),
  unread: msgs.filter((m) => !m.read).length, messages: msgs.slice(-30),
});

// A scan that has been "processing" for minutes was lost (server restarted mid-read): show it as failed so it can be retried.
const STALE_MS = 3 * 60 * 1000;
function scanOf(m) {
  const s = m.paymentScan;
  if (!s?.state) return null;
  if (s.state === 'processing' && Date.now() - new Date(s.at ?? 0).getTime() > STALE_MS) return { state: 'failed', reason: 'Checking this picture took too long. Try again.' };
  return { state: s.state, reason: s.reason ?? null };
}

async function messagesByConversation(ids) {
  const msgs = await Message.find({ conversation: { $in: ids } }).sort({ receivedAt: 1 }).lean();
  const pays = await Payment.find({ _id: { $in: msgs.map((m) => m.paymentId).filter(Boolean) } }).lean();
  const payBy = Object.fromEntries(pays.map((p) => [String(p._id), { id: String(p._id), status: p.status, displayStatus: displayStatus({ ...p, orderId: p.order ? String(p.order) : null }), orderId: p.order ? String(p.order) : null, amount: p.amount, method: p.method, transactionId: p.transactionId ?? null }]));
  const by = {};
  for (const m of msgs) {
    (by[m.conversation] ??= []).push({
      id: String(m._id), from: m.direction === 'outbound' ? 'business' : 'customer', text: m.text ?? (m.attachment ? null : `[${m.messageType} message — not shown]`), at: m.receivedAt.toISOString(), read: Boolean(m.readAt),
      attachment: m.attachment ? { url: `/conversations/${m.conversation}/messages/${m._id}/attachment`, contentType: m.attachment.contentType } : null,
      scan: scanOf(m),
      delivery: m.direction === 'outbound' ? (m.delivery ? { mode: m.delivery.mode, state: m.delivery.state } : { mode: 'simulated', state: 'sent' }) : null,
      payment: m.paymentId ? payBy[String(m.paymentId)] ?? null : null,
    });
  }
  return by;
}

export async function listConversations(limit = 50) {
  const convs = await Conversation.find().sort({ lastMessageAt: -1 }).limit(limit).lean();
  const by = await messagesByConversation(convs.map((c) => c._id));
  return convs.map((c) => shape(c, by[c._id] ?? []));
}

// Seller actions on a conversation: mark its messages read, and/or link it to an order.
export async function updateConversation(id, { read, orderId }) {
  const conv = await Conversation.findById(id);
  if (!conv) return null;
  if (read === true) await Message.updateMany({ conversation: conv._id, readAt: null }, { $set: { readAt: new Date() } });
  if (orderId !== undefined) { conv.orderId = orderId; await conv.save(); }
  const by = await messagesByConversation([conv._id]);
  return shape(conv.toObject(), by[conv._id] ?? []);
}

// ---- Pictures in a conversation --------------------------------------------------------------------------------------------
const ID = /^[a-f\d]{24}$/i;
async function findMessage(convId, msgId) {
  if (!ID.test(String(convId)) || !ID.test(String(msgId))) throw notFound('Message', msgId);
  const msg = await Message.findOne({ _id: msgId, conversation: convId });
  if (!msg) throw notFound('Message', msgId);
  return msg;
}

// The owner saves a picture the customer sent (a payment screenshot, say) into the conversation. It becomes an inbound image message.
export async function addAttachment(convId, buf, name) {
  if (!ID.test(String(convId))) throw notFound('Conversation', convId);
  const conv = await Conversation.findById(convId);
  if (!conv) throw notFound('Conversation', convId);
  const { file, contentType, size, sha256 } = await saveProof(buf, name);
  const at = new Date();
  const msg = await Message.create({ conversation: conv._id, channel: conv.channel, externalId: `upload-${crypto.randomBytes(8).toString('hex')}`, text: null, messageType: 'image', receivedAt: at, attachment: { file, contentType, size, sha256 } });
  await Conversation.updateOne({ _id: conv._id }, { $set: { lastMessageAt: at } });
  return { id: String(msg._id), from: 'customer', text: null, at: at.toISOString(), read: false, attachment: { url: `/conversations/${convId}/messages/${msg._id}/attachment`, contentType }, payment: null };
}

export async function getAttachmentFile(convId, msgId) {
  const msg = await findMessage(convId, msgId);
  const data = await readProof(msg.attachment);
  if (!data) throw notFound('Attachment', msgId);
  return { data, contentType: msg.attachment.contentType };
}

// "Extract payment details" on a picture in the chat. The same reading and the same record as everywhere else; asking twice returns the
// payment already filed instead of making a second one.
export async function extractMessagePayment(convId, msgId) {
  const msg = await findMessage(convId, msgId);
  if (!msg.attachment) throw new ApiError(409, 'CONFLICT', 'This message has no picture to read.');
  if (msg.paymentId) {
    const existing = await Payment.findById(msg.paymentId);
    if (existing) return { payment: publicPayment(existing), extraction: null, existing: true };
  }
  const conv = await Conversation.findById(convId);
  if (!conv?.orderId && msg.paymentScan?.state && msg.paymentScan.state !== 'processing') { // an image from Messages: the automatic pipeline, which can match the order itself
    await Message.updateOne({ _id: msg._id, 'paymentScan.state': { $in: ['failed', 'not_payment'] } }, { $set: { 'paymentScan.state': 'failed' } });
    const r = await retryScan(msg._id);
    if (r.payment) return { payment: publicPayment(r.payment), extraction: null, existing: false };
    throw new ApiError(r.state === 'duplicate' ? 409 : 422, r.state === 'duplicate' ? 'DUPLICATE_SCREENSHOT' : 'EXTRACTION_FAILED', r.reason ?? 'Nothing could be read from this picture.');
  }
  if (!conv?.orderId) throw new ApiError(409, 'CONFLICT', 'Link this chat to an order first, so the payment goes to the right one.');
  const buffer = await readProof(msg.attachment);
  if (!buffer) throw notFound('Attachment', msgId);
  const r = await extractFromImage({ buffer, proofMeta: msg.attachment.toObject?.() ?? msg.attachment, orderId: String(conv.orderId), conversationId: String(conv._id), messageId: String(msg._id) });
  await Message.updateOne({ _id: msg._id }, { $set: { paymentId: r.payment.id, ...(msg.paymentScan?.state ? { 'paymentScan.state': 'filed', 'paymentScan.reason': null } : {}) } });
  return { ...r, existing: false };
}

// An order's conversation: the customer's messages (the original, in time order, never edited), and the specification read out of them.
// The specification is worked out fresh from the messages every time, so a changed instruction updates it and the history stays.
export async function orderConversation(orderId) {
  const conv = await Conversation.findOne({ orderId }).sort({ lastMessageAt: -1 }).lean();
  if (!conv) return { conversation: null, messages: [], spec: extractOrderSpec([]) };
  const messages = ((await messagesByConversation([conv._id]))[conv._id] ?? []).map((m) => ({ ...m, kind: imageKind(m) }));
  return { conversation: { id: String(conv._id), channel: conv.channel, customerName: conv.customerName, isDemo: Boolean(conv.isDemo) }, messages, spec: extractOrderSpec(messages) };
}

// For the reply tools: a conversation and its messages in the same shape the list uses.
export async function conversationWithMessages(id) {
  if (!ID.test(String(id))) throw notFound('Conversation', id);
  const conv = await Conversation.findById(id).lean();
  if (!conv) throw notFound('Conversation', id);
  const by = await messagesByConversation([conv._id]);
  return { conv, messages: by[conv._id] ?? [] };
}
