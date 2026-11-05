import mongoose from 'mongoose';
import Order from '../models/Order.js';
import { asyncHandler, notFound, validationError } from '../utils/errors.js';
import { isPlainObject } from '../utils/validation.js';
import { ApiError } from '../utils/errors.js';
import { checkImage } from '../services/proofStore.js';
import { sendReply, suggestReplies, summariseOrder, suggestFromContext } from '../services/replyService.js';
import { addAttachment, extractMessagePayment, getAttachmentFile, listConversations, updateConversation } from '../services/messageService.js';

const ID = /^[a-f\d]{24}$/i;

// Proposed addition (not yet in docs/api-contract.md): conversations stored from webhooks (or the demo seed).
export const list = asyncHandler(async (req, res) => res.json({ items: await listConversations() }));

// PATCH /api/conversations/:id  body: { read?: true, orderId?: string|null }
export const patch = asyncHandler(async (req, res) => {
  const details = [];
  const b = req.body;
  if (!isPlainObject(b)) throw validationError([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  for (const k of Object.keys(b)) if (!['read', 'orderId'].includes(k)) details.push({ field: k, message: 'Unknown field.' });
  if ('read' in b && b.read !== true) details.push({ field: 'read', message: 'Only true is supported (messages cannot be marked unread).' });
  if ('orderId' in b && b.orderId !== null && !(typeof b.orderId === 'string' && ID.test(b.orderId))) details.push({ field: 'orderId', message: 'Must be an order id or null.' });
  if (!details.length && !('read' in b) && !('orderId' in b)) details.push({ field: 'body', message: 'Provide read and/or orderId.' });
  if (details.length) throw validationError(details);

  if (!ID.test(req.params.id)) throw notFound('Conversation', req.params.id);
  if (typeof b.orderId === 'string' && !(await Order.exists({ _id: new mongoose.Types.ObjectId(b.orderId) }))) throw notFound('Order', b.orderId);
  const conv = await updateConversation(req.params.id, b);
  if (!conv) throw notFound('Conversation', req.params.id);
  res.json(conv);
});

const rawImage = (req) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new ApiError(415, 'UNSUPPORTED_MEDIA', 'Send the image as the request body (Content-Type image/png, image/jpeg or image/webp).');
  checkImage(req.body);
  return req.body;
};
export const uploadAttachment = asyncHandler(async (req, res) => res.status(201).json(await addAttachment(req.params.id, rawImage(req), req.get('X-File-Name'))));
export const attachment = asyncHandler(async (req, res) => {
  const { data, contentType } = await getAttachmentFile(req.params.id, req.params.mid);
  res.set({ 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=300', 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; img-src 'self' data:" });
  res.send(data);
});
export const extractPayment = asyncHandler(async (req, res) => {
  const r = await extractMessagePayment(req.params.id, req.params.mid);
  res.status(r.existing ? 200 : 201).json(r);
});

const orderIdOf = (v) => (typeof v === 'string' && v ? v : undefined);
// POST /api/conversations/:id/suggestions  { orderId? } -> { source: 'ai' | 'rules', suggestions: [{ id, text }], orderId, candidates }. Nothing is sent.
export const suggestions = asyncHandler(async (req, res) => res.json(await suggestReplies(req.params.id, orderIdOf(req.body?.orderId))));
// GET /api/conversations/:id/order-summary?orderId=  -> the drafted text for the owner to preview. Nothing is sent.
export const orderSummary = asyncHandler(async (req, res) => res.json(await summariseOrder(req.params.id, orderIdOf(req.query.orderId))));
// POST /api/conversations/:id/messages  { text } -> sends exactly that text (only ever called after the owner chose to send it).
export const sendMessage = asyncHandler(async (req, res) => res.status(201).json(await sendReply(req.params.id, req.body?.text)));
// POST /api/ai/suggest-replies  { context } -> the same generator on a context the browser built (used by the demo, whose chats are not in the database).
export const suggestFromBody = asyncHandler(async (req, res) => {
  const c = req.body?.context;
  if (!isPlainObject(c) || !Array.isArray(c.recent)) throw validationError([{ field: 'context', message: 'Send the conversation context.' }]);
  res.json(await suggestFromContext({ customer: c.customer ?? null, channel: c.channel ?? null, recent: c.recent.slice(-8), order: c.order ?? null }));
});
