import crypto from 'node:crypto';
import { log } from '../utils/log.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import Order from '../models/Order.js';
import { getLedger } from './paymentService.js';
import { getSettings } from './settingsService.js';
import { conversationWithMessages } from './messageService.js';
import { extractOrderSpec, imageKind } from './orderSpec.js';
import { groqJson } from './groqClient.js';
import { channels, listStatuses, clearStatusCache } from './integrations/index.js';
import { markNeedsAttention, refreshInstagramIfDue, resolveConfig } from './integrations/credentials.js';
import { REPLY_SYSTEM, cleanSuggestions, orderSummary, replyContext, replyPrompt, ruleSuggestions, shortId } from './replyLogic.js';
import { ApiError, notFound, validationError } from '../utils/errors.js';

const ID = /^[a-f\d]{24}$/i;
const MAX_TEXT = 1000;
const WINDOW_MS = 24 * 3600000; // Meta's customer-service window

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

// A refused send becomes an error the owner can act on. Nothing is stored (a message WhatsApp did not accept never appears as sent), and a dead token is
// flagged in Settings at once.
const HTTP = { token: 401, recipient_not_allowed: 422, window_closed: 409, rate_limit: 429, invalid: 422, invalid_recipient: 422, undeliverable: 422, sender: 502, config: 409, network: 502 };
const CODE = { token: 'TOKEN_INVALID', recipient_not_allowed: 'RECIPIENT_NOT_ALLOWED', window_closed: 'WINDOW_CLOSED', rate_limit: 'RATE_LIMITED', invalid: 'INVALID_REQUEST', invalid_recipient: 'INVALID_RECIPIENT', undeliverable: 'UNDELIVERABLE', sender: 'SENDER_INVALID', config: 'NOT_CONNECTED', network: 'NETWORK_ERROR' };
function sendFailure(conv, r) {
  if (r.kind === 'token' || r.code === 190) { markNeedsAttention(conv.channel, r.reason).catch(() => {}); clearStatusCache(); } // the token is dead: show it in Settings
  log.warn('send', `${conv.channel}: message not sent`, { reason: r.kind ?? 'other', metaCode: r.code ?? null });
  return new ApiError(HTTP[r.kind] ?? 502, CODE[r.kind] ?? 'SEND_FAILED', r.reason);
}

// Sends an approved WhatsApp template (the only kind of message allowed outside the 24-hour window). The template is named in WHATSAPP_TEMPLATE_NAME (language
// WHATSAPP_TEMPLATE_LANG, default en_US); Meta gives every test number "hello_world". It is stored only if WhatsApp accepts it.
export async function sendTemplateReply(convId) {
  if (!ID.test(String(convId))) throw notFound('Conversation', convId);
  const conv = await Conversation.findById(convId);
  if (!conv) throw notFound('Conversation', convId);
  if (conv.channel !== 'whatsapp' || conv.isDemo) throw new ApiError(409, 'NOT_AVAILABLE', 'Template messages are sent to real WhatsApp conversations only.');
  const status = (await listStatuses()).find((s) => s.channel === 'whatsapp');
  if (status?.state !== 'connected') throw new ApiError(409, 'NOT_CONNECTED', `WhatsApp is not connected, so nothing was sent. ${status?.statusReason ?? ''}`.trim());
  const name = process.env.WHATSAPP_TEMPLATE_NAME || 'hello_world'; const language = process.env.WHATSAPP_TEMPLATE_LANG || 'en_US';
  const r = await channels.whatsapp.sendTemplate(conv.contactId, { name, language }, {}, await resolveConfig());
  if (!r.ok) throw sendFailure(conv, r);
  const at = new Date();
  const msg = await Message.create({ conversation: conv._id, channel: 'whatsapp', externalId: r.externalId, direction: 'outbound', text: `[Template message: ${name}]`, messageType: 'template', receivedAt: at, readAt: at, delivery: { mode: 'real', state: 'accepted', sentAt: at } });
  await Conversation.updateOne({ _id: conv._id }, { $set: { lastMessageAt: at } });
  return { id: String(msg._id), from: 'business', text: msg.text, at: at.toISOString(), read: true, attachment: null, scan: null, payment: null, delivery: { mode: 'real', state: 'accepted' } };
}

// Sends the text the owner confirmed. A real send goes through the channel's API and is stored only if it succeeded. A demo conversation, or a
// sample conversation is stored as a SIMULATED send. A real conversation on a channel that is not connected is refused (409 NOT_CONNECTED).
export async function sendReply(convId, text) {
  const clean = typeof text === 'string' ? text.trim() : '';
  if (!clean) throw validationError([{ field: 'text', message: 'Write a message first.' }]);
  if (clean.length > MAX_TEXT) throw validationError([{ field: 'text', message: `Keep it under ${MAX_TEXT} characters.` }]);
  if (!ID.test(String(convId))) throw notFound('Conversation', convId);
  const conv = await Conversation.findById(convId);
  if (!conv) throw notFound('Conversation', convId);

  const status = (await listStatuses()).find((s) => s.channel === conv.channel);
  // A real customer on a channel that is not connected cannot be written to: say why, store nothing (never a message that looks delivered).
  if (!conv.isDemo && status?.state !== 'connected') throw new ApiError(409, 'NOT_CONNECTED', `${conv.channel === 'instagram' ? 'Instagram' : 'WhatsApp'} is not connected, so this message was not sent. ${status?.statusReason ?? ''} Reconnect it in Settings.`.trim());
  let mode = 'simulated'; let externalId = `out-${crypto.randomBytes(8).toString('hex')}`;
  if (!conv.isDemo && status?.state === 'connected') {
    // Meta only accepts a free-form reply within 24 hours of the customer's last message. Outside that window a pre-approved WhatsApp message template
    // is required, which this app does not send: refuse clearly instead of letting Meta reject it.
    const lastIn = await Message.findOne({ conversation: conv._id, direction: 'inbound' }).sort({ receivedAt: -1 }).select('receivedAt').lean();
    if (!lastIn || Date.now() - new Date(lastIn.receivedAt).getTime() > WINDOW_MS) {
      throw new ApiError(409, 'WINDOW_CLOSED', `${conv.customerName ?? 'This customer'} last wrote more than 24 hours ago. ${conv.channel === 'whatsapp' ? 'Send an approved template message to start the conversation again; once they reply you can write freely. ' : ''}${conv.channel === 'whatsapp' ? 'WhatsApp only allows a free-form reply within 24 hours of the customer’s last message; after that an approved message template is required.' : 'Instagram only allows a reply within 24 hours of the customer’s last message.'} Reply once they write again.`);
    }
    if (conv.channel === 'instagram') await refreshInstagramIfDue(); // a token close to expiry is renewed before it is used
    const r = await channels[conv.channel].sendText(conv.contactId, clean, {}, await resolveConfig());
    if (!r.ok) throw sendFailure(conv, r);
    mode = 'real'; if (r.externalId) externalId = r.externalId;
  }
  const at = new Date();
  const msg = await Message.create({ conversation: conv._id, channel: conv.channel, externalId, direction: 'outbound', text: clean, messageType: 'text', receivedAt: at, readAt: at, isDemo: Boolean(conv.isDemo), delivery: { mode, state: mode === 'real' ? 'accepted' : 'sent', sentAt: at } });
  await Conversation.updateOne({ _id: conv._id }, { $set: { lastMessageAt: at } });
  return { id: String(msg._id), from: 'business', text: clean, at: at.toISOString(), read: true, attachment: null, scan: null, payment: null, delivery: { mode, state: mode === 'real' ? 'accepted' : 'sent' } };
}
