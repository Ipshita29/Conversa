import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';

// Stores normalised inbound messages. The unique (channel, externalId) index makes webhook retries idempotent.
// Messages are only stored: no order is created and no LLM call is made until the seller asks for extraction.
export async function ingest(messages) {
  let stored = 0;
  let duplicates = 0;
  for (const m of messages) {
    const conv = await upsertConversation(m);
    try {
      await Message.create({ conversation: conv._id, channel: m.channel, externalId: m.externalId, text: m.text, messageType: m.messageType, receivedAt: m.receivedAt });
      stored++;
    } catch (err) {
      if (err.code === 11000) duplicates++;
      else throw err;
    }
  }
  return { stored, duplicates };
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
  const by = {};
  for (const m of msgs) (by[m.conversation] ??= []).push({ id: String(m._id), from: 'customer', text: m.text ?? `[${m.messageType} message — not shown]`, at: m.receivedAt.toISOString(), read: Boolean(m.readAt) });
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
