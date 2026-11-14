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
import { downloadMediaUrl, fetchProfile } from './integrations/instagramService.js';
import { resolveConfig } from './integrations/credentials.js';
import { log } from '../utils/log.js';
import { ApiError, notFound } from '../utils/errors.js';

// Stores normalised inbound messages. The unique (channel, externalId) index makes webhook retries idempotent.
// Messages are only stored: no order is created and no LLM call is made until the seller asks for extraction.
export async function ingest(messages) {
  let stored = 0;
  let duplicates = 0;
  const toRead = new Set(); // conversations that just received customer text: candidates for an automatic order draft
  for (const m of messages) {
    log.info('inbound', `${m.channel}: message received`, { messageId: m.externalId, type: m.messageType, sender: mask(m.contactId), hasText: Boolean(m.text), mediaId: m.mediaId ?? null });
    const conv = await upsertConversation(m);
    try {
      if (!conv.customerName && m.channel === 'instagram') { // Instagram sends no name with a message: ask for the profile once, where permitted
        const prof = await fetchProfile(m.contactId, {}, await resolveConfig()).catch(() => null);
        if (prof?.name) { await Conversation.updateOne({ _id: conv._id, customerName: null }, { $set: { customerName: prof.name } }); conv.customerName = prof.name; }
      }
      // The message is saved FIRST, so it is in the Inbox at once; a picture is downloaded afterwards (the Inbox shows it as "loading").
      const isImage = m.messageType === 'image';
      const msg = await Message.create({ conversation: conv._id, channel: m.channel, externalId: m.externalId, text: m.text, messageType: m.messageType, receivedAt: m.receivedAt, attachment: null, media: isImage ? { id: m.mediaId ?? null, url: m.mediaUrl ?? null, error: null, attempts: 0, state: 'downloading' } : null, paymentScan: null });
      stored++;
      log.info('inbound', `${m.channel}: message stored`, { messageId: m.externalId, conversation: String(conv._id), text: Boolean(m.text), picture: isImage ? 'downloading' : null });
      if (m.text) toRead.add(String(conv._id));
      if (isImage) trackMedia(finishMedia(msg._id, m, conv._id));
      // A payment-looking message in a chat already linked to an order is filed as Verification pending (never as paid).
      await draftFromIncoming(conv, m.text, String(msg._id), m.receivedAt);
    } catch (err) {
      if (err.code === 11000) { duplicates++; log.info('inbound', `${m.channel}: duplicate delivery ignored`, { messageId: m.externalId }); }
      else { log.error('inbound', `${m.channel}: processing failed`, { messageId: m.externalId, error: err.message }); throw err; }
    }
  }
  return { stored, duplicates, toRead: [...toRead] };
}

// Downloads a stored message's picture in the background, then files the result: the picture (and a payment check), or the reason it failed.
const mediaJobs = new Set();
const trackMedia = (p) => { mediaJobs.add(p); p.finally(() => mediaJobs.delete(p)); };
export const mediaIdle = () => Promise.allSettled([...mediaJobs]);
async function finishMedia(messageId, m, convId, prior = null) {
  try {
    const { attachment, media } = await fetchAttachment(m, prior);
    const state = attachment ? 'ready' : 'failed';
    await Message.updateOne({ _id: messageId }, { $set: { attachment, media: { ...media, state }, paymentScan: attachment ? { state: 'processing', at: new Date() } : { state: 'failed', reason: `The picture could not be downloaded, so it was not checked for a payment. ${media?.error ?? ''}`.trim(), at: new Date() } } });
    if (attachment) queueScan(messageId);
    return Boolean(attachment);
  } catch (e) { log.error('media', 'Picture processing failed', { messageId: String(messageId), error: e.message }); return false; }
}

const mask = (id) => (id ? `${String(id).slice(0, 3)}…${String(id).slice(-2)}` : null); // enough to tell senders apart in a log, never the whole number

// A customer's picture: downloaded with the connected account's own token (WhatsApp media id, or an Instagram CDN link) and kept like a payment proof.
// Never fatal: the message is stored either way. When the picture cannot be fetched the reason and the platform id are kept so it can be retried.
async function fetchAttachment(m, prior = null) {
  if (m.messageType !== 'image') return { attachment: null, media: null };
  const media = { id: m.mediaId ?? null, url: m.mediaUrl ?? null, error: null, attempts: (prior?.attempts ?? 0) + 1 };
  try {
    const report = {};
    const buf = m.channel === 'whatsapp' && m.mediaId ? await downloadMedia(m.mediaId, { report }, await resolveConfig())
      : m.channel === 'instagram' && m.mediaUrl ? await downloadMediaUrl(m.mediaUrl) : null;
    if (!buf) { media.error = report.reason ?? 'The picture could not be downloaded.'; log.warn('media', `${m.channel}: picture not downloaded`, { messageId: m.externalId, mediaId: m.mediaId ?? null, reason: media.error }); return { attachment: null, media }; }
    const { file, contentType, size, sha256 } = await saveProof(buf, null);
    log.info('media', `${m.channel}: picture downloaded`, { messageId: m.externalId, bytes: size, contentType });
    return { attachment: { file, contentType, size, sha256 }, media: { ...media, error: null } };
  } catch (e) { media.error = e.message; log.warn('media', `${m.channel}: picture not stored`, { messageId: m.externalId, reason: e.message }); return { attachment: null, media }; }
}

// Downloads the pictures that failed earlier (the connection was down or the token had expired), then checks them for a payment. Returns how many came back.
export async function retryMedia({ conversationId, messageId } = {}) {
  const q = { attachment: null, messageType: 'image', 'media.id': { $ne: null }, $or: [{ 'media.state': { $ne: 'downloading' } }, { updatedAt: { $lt: new Date(Date.now() - 120000) } }], ...(conversationId ? { conversation: conversationId } : {}), ...(messageId ? { _id: messageId } : {}), direction: 'inbound' };
  let recovered = 0; const failed = [];
  for (const msg of await Message.find(q).limit(20)) {
    await Message.updateOne({ _id: msg._id }, { $set: { 'media.state': 'downloading' } });
    const ok = await finishMedia(msg._id, { channel: msg.channel, externalId: msg.externalId, messageType: 'image', mediaId: msg.media?.id, mediaUrl: msg.media?.url }, msg.conversation, msg.media);
    if (ok) recovered++; else failed.push({ id: String(msg._id), reason: (await Message.findById(msg._id).lean())?.media?.error });
  }
  return { recovered, failed };
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
  lastInboundAt: [...msgs].reverse().find((m) => m.from === 'customer')?.at ?? null, // Meta only allows free-form replies for 24 hours after this
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
      picture: m.messageType === 'image' && !m.attachment ? { state: m.media?.state === 'downloading' && Date.now() - new Date(m.createdAt ?? 0).getTime() < 120000 ? 'loading' : 'failed', reason: m.media?.error ?? null } : null,
      delivery: m.direction === 'outbound' ? (m.delivery ? { mode: m.delivery.mode, state: m.delivery.state, error: m.delivery.error ?? null } : { mode: 'simulated', state: 'sent', error: null }) : null,
      payment: m.paymentId ? payBy[String(m.paymentId)] ?? null : null,
    });
  }
  return by;
}

export async function listConversations(limit = 50, dataset = 'all') {
  const convs = await Conversation.find(dataset === 'all' ? {} : { isDemo: dataset === 'demo' ? true : { $ne: true } }).sort({ lastMessageAt: -1 }).limit(limit).lean();
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

// The reference pictures each order's customer sent, newest first, for the Orders gallery. An order's pictures live in its linked conversation; a payment
// screenshot (or a picture still being read) is never a reference picture. One query for all the orders asked about, not one per order.
export async function referenceImagesByOrder(orderIds) {
  const ids = orderIds.filter((i) => ID.test(String(i)));
  if (!ids.length) return {};
  const convs = await Conversation.find({ orderId: { $in: ids } }).select('orderId').lean();
  if (!convs.length) return {};
  const orderOf = Object.fromEntries(convs.map((c) => [String(c._id), String(c.orderId)]));
  const msgs = await Message.find({ conversation: { $in: convs.map((c) => c._id) }, attachment: { $ne: null } }).sort({ receivedAt: -1 }).select('conversation attachment paymentId paymentScan receivedAt').lean();
  const out = {};
  for (const m of msgs) {
    if (imageKind({ attachment: m.attachment, payment: m.paymentId, scan: m.paymentScan }) !== 'reference') continue;
    (out[orderOf[String(m.conversation)]] ??= []).push({ messageId: String(m._id), url: `/conversations/${m.conversation}/messages/${m._id}/attachment`, contentType: m.attachment.contentType ?? null, at: m.receivedAt.toISOString() });
  }
  return out;
}

// For the reply tools: a conversation and its messages in the same shape the list uses.
export async function conversationWithMessages(id) {
  if (!ID.test(String(id))) throw notFound('Conversation', id);
  const conv = await Conversation.findById(id).lean();
  if (!conv) throw notFound('Conversation', id);
  const by = await messagesByConversation([conv._id]);
  return { conv, messages: by[conv._id] ?? [] };
}

// Delivery receipts for messages we sent (WhatsApp statuses, Instagram "seen"). A message only ever moves forward (sent -> delivered -> read); a
// "failed" receipt is kept unless the customer has already read it. Receipts for messages we do not know (sent elsewhere) are ignored.
const RANK = { accepted: 0, sent: 1, delivered: 2, read: 3 }; // accepted = Meta took the request; only its webhooks say it was sent, delivered or read
export async function applyStatuses(statuses) {
  let updated = 0;
  for (const st of statuses) {
    const msg = await Message.findOne({ channel: st.channel, externalId: st.externalId, direction: 'outbound' });
    if (!msg?.delivery) continue;
    const cur = msg.delivery.state;
    if (st.status === 'failed' ? cur === 'read' : (RANK[st.status] ?? 0) <= (RANK[cur] ?? 0)) continue;
    await Message.updateOne({ _id: msg._id }, { $set: { 'delivery.state': st.status, 'delivery.error': st.status === 'failed' ? st.error ?? 'Meta could not deliver this message.' : null, ...(st.status === 'read' ? { readAt: st.at } : {}) } });
    updated++;
  }
  return updated;
}
