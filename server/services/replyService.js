import crypto from 'node:crypto';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import Order from '../models/Order.js';
import { getLedger } from './paymentService.js';
import { getSettings } from './settingsService.js';
import { conversationWithMessages } from './messageService.js';
import { extractOrderSpec, imageKind } from './orderSpec.js';
import { groqJson } from './groqClient.js';
import { channels, listStatuses } from './integrations/index.js';
import { REPLY_SYSTEM, cleanSuggestions, orderSummary, replyContext, replyPrompt, ruleSuggestions, shortId } from './replyLogic.js';
import { ApiError, notFound, validationError } from '../utils/errors.js';

const ID = /^[a-f\d]{24}$/i;
const MAX_TEXT = 1000;

// The orders a chat can be about: the one it is linked to; otherwise the customer's other open orders with the same name.
// With more than one candidate and none chosen, nothing is assumed: the caller shows the choice to the owner.
async function resolveOrder(conv, orderId) {
  const open = ['pending', 'confirmed', 'in_progress'];
  const linked = conv.orderId ? await Order.findById(conv.orderId) : null;
  let candidates = linked ? [linked] : [];
  if (!linked && conv.customerName) {
    const same = await Order.find({ customerName: new RegExp(`^${conv.customerName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), status: { $in: open } }).limit(10);
    candidates = same;
  }
  let order = null;
  if (orderId) {
    if (!ID.test(orderId)) throw validationError([{ field: 'orderId', message: 'Must be an order id.' }]);
    order = await Order.findById(orderId);
    if (!order) throw notFound('Order', orderId);
    if (!candidates.some((o) => String(o._id) === String(order._id))) candidates = [order, ...candidates];
  } else if (candidates.length === 1) order = candidates[0];
  return { order, candidates: candidates.map((o) => ({ id: String(o._id), item: o.item, quantity: o.quantity, deadline: o.deadline ?? null, shortId: shortId(String(o._id)) })) };
}

async function load(convId, orderId) {
  const { conv, messages } = await conversationWithMessages(convId);
  const { order, candidates } = await resolveOrder(conv, orderId);
  const [ledger, settings] = await Promise.all([order ? getLedger() : null, getSettings()]);
  const row = order ? ledger.rows.find((r) => r.orderId === String(order._id)) ?? null : null;
  return { conv, messages, order: order ? order.toJSON() : null, candidates, row, tz: settings.timezone };
}

// AI first (the same Groq integration as order extraction), rules when it is unavailable or when none of its replies stay within the facts.
export async function suggestFromContext(ctx, { ai = groqJson } = {}) {
  try {
    const raw = await ai({ system: REPLY_SYSTEM, user: replyPrompt(ctx) });
    const picked = cleanSuggestions(raw, ctx);
    if (picked.length) return { source: 'ai', suggestions: picked };
  } catch (e) { if (!(e instanceof ApiError) || e.status !== 503) throw e; }
  return { source: 'rules', suggestions: ruleSuggestions(ctx) };
}

export async function suggestReplies(convId, orderId, deps) {
  const { conv, messages, order, candidates, row, tz } = await load(convId, orderId);
  const ctx = replyContext({ customerName: conv.customerName, channel: conv.channel, messages, order, row, tz });
  return { ...(await suggestFromContext(ctx, deps)), orderId: order?.id ?? null, candidates };
}

export async function summariseOrder(convId, orderId) {
  const { conv, messages, order, candidates, row, tz } = await load(convId, orderId);
  if (!order) return { summary: null, candidates, reason: candidates.length > 1 ? 'choose' : 'no_order' };
  const spec = extractOrderSpec(messages.map((m) => ({ ...m, kind: imageKind(m) })));
  return { summary: orderSummary(order, row, { tz, spec, customerName: conv.customerName }), candidates, reason: null };
}

// Sends the text the owner confirmed. A real send goes through the channel's API and is stored only if it succeeded. A demo conversation, or a
// channel that is not connected, is stored as a SIMULATED send: it appears in Conversa and nothing reaches the customer.
export async function sendReply(convId, text) {
  const clean = typeof text === 'string' ? text.trim() : '';
  if (!clean) throw validationError([{ field: 'text', message: 'Write a message first.' }]);
  if (clean.length > MAX_TEXT) throw validationError([{ field: 'text', message: `Keep it under ${MAX_TEXT} characters.` }]);
  if (!ID.test(String(convId))) throw notFound('Conversation', convId);
  const conv = await Conversation.findById(convId);
  if (!conv) throw notFound('Conversation', convId);

  const status = (await listStatuses()).find((s) => s.channel === conv.channel);
  let mode = 'simulated'; let externalId = `out-${crypto.randomBytes(8).toString('hex')}`;
  if (!conv.isDemo && status?.status === 'connected') {
    const r = await channels[conv.channel].sendText(conv.contactId, clean);
    if (!r.ok) throw new ApiError(502, 'SEND_FAILED', r.reason);
    mode = 'real'; if (r.externalId) externalId = r.externalId;
  }
  const at = new Date();
  const msg = await Message.create({ conversation: conv._id, channel: conv.channel, externalId, direction: 'outbound', text: clean, messageType: 'text', receivedAt: at, readAt: at, isDemo: Boolean(conv.isDemo), delivery: { mode, state: 'sent', sentAt: at } });
  await Conversation.updateOne({ _id: conv._id }, { $set: { lastMessageAt: at } });
  return { id: String(msg._id), from: 'business', text: clean, at: at.toISOString(), read: true, attachment: null, scan: null, payment: null, delivery: { mode, state: 'sent' } };
}
