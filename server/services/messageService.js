import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import Payment from '../models/Payment.js';
import crypto from 'node:crypto';
import { draftFromIncoming, extractFromImage, publicPayment } from './paymentService.js';
import { saveProof, readProof } from './proofStore.js';
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
      const msg = await Message.create({ conversation: conv._id, channel: m.channel, externalId: m.externalId, text: m.text, messageType: m.messageType, receivedAt: m.receivedAt, attachment });
      stored++;
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

async function messagesByConversation(ids) {
  const msgs = await Message.find({ conversation: { $in: ids } }).sort({ receivedAt: 1 }).lean();
  const pays = await Payment.find({ _id: { $in: msgs.map((m) => m.paymentId).filter(Boolean) } }).lean();
  const payBy = Object.fromEntries(pays.map((p) => [String(p._id), { id: String(p._id), status: p.status, amount: p.amount, method: p.method, transactionId: p.transactionId ?? null }]));
  const by = {};
  for (const m of msgs) {
    (by[m.conversation] ??= []).push({
      id: String(m._id), from: 'customer', text: m.text ?? (m.attachment ? null : `[${m.messageType} message — not shown]`), at: m.receivedAt.toISOString(), read: Boolean(m.readAt),
      attachment: m.attachment ? { url: `/conversations/${m.conversation}/messages/${m._id}/attachment`, contentType: m.attachment.contentType } : null,
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
  if (!conv?.orderId) throw new ApiError(409, 'CONFLICT', 'Link this chat to an order first, so the payment goes to the right one.');
  const buffer = await readProof(msg.attachment);
  if (!buffer) throw notFound('Attachment', msgId);
  const r = await extractFromImage({ buffer, proofMeta: msg.attachment.toObject?.() ?? msg.attachment, orderId: String(conv.orderId), conversationId: String(conv._id), messageId: String(msg._id) });
  await Message.updateOne({ _id: msg._id }, { $set: { paymentId: r.payment.id } });
  return { ...r, existing: false };
}
