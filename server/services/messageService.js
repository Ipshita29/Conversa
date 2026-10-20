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

export async function listConversations(limit = 50) {
  const convs = await Conversation.find().sort({ lastMessageAt: -1 }).limit(limit).lean();
  const msgs = await Message.find({ conversation: { $in: convs.map((c) => c._id) } }).sort({ receivedAt: 1 }).lean();
  const by = {};
  for (const m of msgs) (by[m.conversation] ??= []).push({ id: String(m._id), from: 'customer', text: m.text ?? `[${m.messageType} message — not shown]`, at: m.receivedAt.toISOString() });
  return convs.map((c) => ({
    id: String(c._id), channel: c.channel, customerName: c.customerName || `Unknown (${c.contactId})`,
    ...(c.channel === 'whatsapp' ? { phone: c.contactId } : { handle: c.contactId }),
    orderId: null, messages: (by[c._id] ?? []).slice(-30),
  }));
}
