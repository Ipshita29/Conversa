import { promoteReadyDrafts } from '../services/orderService.js';
import Order from '../models/Order.js';
import Payment from '../models/Payment.js';
import Conversation from '../models/Conversation.js';
import { asyncHandler, badQuery, notFound, validationError, ApiError } from '../utils/errors.js';
import { validateOrderInput, validateEvidenceInput, ORDER_STATUSES, PAYMENT_STATUSES, SOURCES } from '../utils/validation.js';
import { getSettings } from '../services/settingsService.js';
import { riskMap, withRisk } from '../services/orderService.js';
import { orderConversation, referenceImagesByOrder } from '../services/messageService.js';
import { datasetOf, orderFilter } from '../utils/dataset.js';
import { checkImage, saveProof, readProof, deleteProof, hashImage } from '../services/proofStore.js';

const TERMINAL = ['completed', 'cancelled'];
const SORTS = { deadline: 1, '-deadline': -1, createdAt: 1, '-createdAt': -1 };
const ID = /^[a-f\d]{24}$/i;

async function findOrder(id) {
  if (!ID.test(id)) throw notFound('Order', id);
  const order = await Order.findById(id);
  if (!order) throw notFound('Order', id);
  return order;
}

// Each order's pictures: what the customer sent in the order's conversation AND what the owner attached to the order itself, newest first. One source of
// truth for the Orders gallery, the order details and every order response, so Real and Demo orders behave the same.
const ownPictures = (o) => (o.referenceImages ?? []).map((i) => ({ messageId: null, id: String(i._id), url: `/orders/${o.id}/reference-images/${i._id}`, contentType: i.contentType ?? null, at: new Date(i.addedAt ?? o.createdAt ?? 0).toISOString() }));
export async function picturesOf(orders) {
  const fromChats = await referenceImagesByOrder(orders.map((o) => String(o._id ?? o.id)));
  return Object.fromEntries(orders.map((o) => {
    const id = String(o._id ?? o.id);
    return [id, [...(fromChats[id] ?? []), ...ownPictures({ ...o.toObject?.() ?? o, id })].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))];
  }));
}
const pictureFields = (list = []) => ({ referenceImage: list[0] ?? null, referenceImages: list, referenceImageCount: list.length });
const withPictures = async (order, risks) => ({ ...withRisk(order, risks), ...pictureFields((await picturesOf([order]))[String(order._id)]) });

const enumList = (raw, allowed, field, details) => {
  const vals = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  const badVals = vals.filter((v) => !allowed.includes(v));
  if (badVals.length) details.push({ field, message: `Unknown value '${badVals[0]}'. Allowed: ${allowed.join(', ')}.` });
  return vals;
};

export const list = asyncHandler(async (req, res) => {
  const q = req.query;
  const details = [];
  const filter = {}; // built only from validated enum values: client input is never used as a Mongo query
  if (q.status) filter.status = { $in: enumList(q.status, ORDER_STATUSES, 'status', details) };
  if (q.paymentStatus) filter.paymentStatus = { $in: enumList(q.paymentStatus, PAYMENT_STATUSES, 'paymentStatus', details) };
  if (q.source) filter.source = { $in: enumList(q.source, SOURCES, 'source', details) };
  Object.assign(filter, orderFilter(datasetOf(q.dataset)));
  const page = q.page === undefined ? 1 : Number(q.page);
  const pageSize = q.pageSize === undefined ? 20 : Number(q.pageSize);
  if (!Number.isInteger(page) || page < 1) details.push({ field: 'page', message: 'Must be a positive integer.' });
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) details.push({ field: 'pageSize', message: 'Must be between 1 and 100.' });
  const sort = q.sort ?? 'deadline';
  if (!(sort in SORTS)) details.push({ field: 'sort', message: `Must be one of: ${Object.keys(SORTS).join(', ')}.` });
  if (details.length) throw badQuery(details);

  const settings = await getSettings();
  const [orders, risks] = await Promise.all([Order.find(filter).limit(5000), riskMap(settings)]);
  const dir = SORTS[sort];
  const key = sort.replace('-', '');
  orders.sort((a, b) => {
    if (key === 'deadline') { if (!a.deadline && !b.deadline) return 0; if (!a.deadline) return 1; if (!b.deadline) return -1; } // nulls last
    return dir * (a[key] - b[key]);
  });
  const pageOrders = orders.slice((page - 1) * pageSize, page * pageSize);
  const pictures = await picturesOf(pageOrders);
  res.json({ items: pageOrders.map((o) => ({ ...withRisk(o, risks), ...pictureFields(pictures[String(o._id)]) })), page, pageSize, total: orders.length });
});

export const create = asyncHandler(async (req, res) => {
  const { value, details } = validateOrderInput(req.body);
  if (details.length) throw validationError(details);
  const order = await Order.create(value);
  const risks = await riskMap(await getSettings());
  res.status(201).location(`/api/orders/${order.id}`).json(await withPictures(order, risks));
});

export const get = asyncHandler(async (req, res) => {
  const order = await findOrder(req.params.id);
  res.json(await withPictures(order, await riskMap(await getSettings())));
});

export const update = asyncHandler(async (req, res) => {
  const { value, details } = validateOrderInput(req.body, { partial: true });
  if (!details.length && Object.keys(value).length === 0) details.push({ field: 'body', message: 'Provide at least one field to update.' });
  if (details.length) throw validationError(details);

  const order = await findOrder(req.params.id);
  if (TERMINAL.includes(order.status) && value.status && value.status !== order.status) {
    throw new ApiError(409, 'CONFLICT', `Cannot change a ${order.status} order to '${value.status}'.`);
  }
  if (value.status === 'completed' && order.status !== 'completed') order.completedAt = new Date(); // the moment it was delivered: what on-time delivery is measured from
  order.set(value);
  await order.save();
  // The owner just supplied what the scheduler needs (a product, quantity, delivery time or preparation time) and nothing is missing now: the request becomes a
  // real order. Editing a note or a customisation on a draft never confirms it, and putting it back to draft is respected.
  const SCHEDULING = ['item', 'quantity', 'deadline', 'prepTimeMinutes'];
  if (order.status === 'draft' && value.status !== 'draft' && SCHEDULING.some((f) => f in value) && (await promoteReadyDrafts({ orderId: order._id, reviewed: true })).length) await order.constructor.findById(order._id).then((fresh) => { if (fresh) order.status = fresh.status; });
  res.json(await withPictures(order, await riskMap(await getSettings())));
});

// DELETE /api/orders/:id : permanently removes the order. Its own payment records go with it (a ledger row for an order that no longer exists would be
// meaningless), its own reference pictures are deleted from disk, and any chat that was linked to it is simply unlinked: the conversation and its messages
// stay. Plan, What-if, Insights and Payments read the database, so they stop counting it at once (and open browsers are told).
export const remove = asyncHandler(async (req, res) => {
  const order = await findOrder(req.params.id);
  const mine = (order.referenceImages ?? []).map((i) => i.toObject?.() ?? i);
  await Payment.deleteMany({ order: order._id });
  await Conversation.updateMany({ orderId: order._id }, { $set: { orderId: null } });
  await Order.deleteOne({ _id: order._id });
  for (const img of mine) await deleteProof(img).catch(() => {});
  res.json({ deleted: true, id: String(order._id) });
});

// Attaches a reference to payment evidence. It never changes paymentStatus: only the seller does that via PATCH.
export const addPaymentEvidence = asyncHandler(async (req, res) => {
  const { value, details } = validateEvidenceInput(req.body);
  if (details.length) throw validationError(details);
  const order = await findOrder(req.params.id);
  order.paymentEvidence.push(value);
  await order.save();
  res.status(201).json(withRisk(order, await riskMap(await getSettings())));
});

export const conversation = asyncHandler(async (req, res) => res.json(await orderConversation((await findOrder(req.params.id)).id)));

// ---- Pictures attached to an order -------------------------------------------------------------------------------------------------------------
const MAX_PICTURES = 8;
// POST /api/orders/:id/reference-images  (the image as the raw body, like every other picture upload). The newest picture is the one the gallery shows;
// the same picture twice is kept once.
export const addReferenceImage = asyncHandler(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new ApiError(415, 'UNSUPPORTED_MEDIA', 'Send the image as the request body (Content-Type image/png, image/jpeg or image/webp).');
  checkImage(req.body);
  const order = await findOrder(req.params.id);
  const sha = hashImage(req.body);
  const dupe = order.referenceImages.find((i) => i.sha256 === sha);
  if (!dupe) {
    if (order.referenceImages.length >= MAX_PICTURES) throw new ApiError(409, 'CONFLICT', `An order can hold up to ${MAX_PICTURES} pictures. Remove one first.`);
    const saved = await saveProof(req.body, req.get('X-File-Name'));
    order.referenceImages.push({ file: saved.file, contentType: saved.contentType, size: saved.size, sha256: saved.sha256, originalName: saved.originalName ?? null, addedAt: new Date() });
    await order.save();
  }
  res.status(dupe ? 200 : 201).json(await withPictures(order, await riskMap(await getSettings())));
});

// GET /api/orders/:id/reference-images/:imageId: the stored original, with the same safe headers as every other picture.
export const referenceImageFile = asyncHandler(async (req, res) => {
  const order = await findOrder(req.params.id);
  const img = ID.test(req.params.imageId) ? order.referenceImages.id(req.params.imageId) : null;
  const data = img ? await readProof(img) : null;
  if (!img || !data) throw notFound('Picture', req.params.imageId);
  res.set({ 'Content-Type': img.contentType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=300', 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; img-src 'self' data:" });
  res.send(data);
});

// DELETE /api/orders/:id/reference-images/:imageId: removes a picture the owner attached (never one a customer sent in a conversation).
export const removeReferenceImage = asyncHandler(async (req, res) => {
  const order = await findOrder(req.params.id);
  const img = ID.test(req.params.imageId) ? order.referenceImages.id(req.params.imageId) : null;
  if (!img) throw notFound('Picture', req.params.imageId);
  const gone = { file: img.file };
  img.deleteOne(); await order.save(); await deleteProof(gone);
  res.json(await withPictures(order, await riskMap(await getSettings())));
});
