import Order from '../models/Order.js';
import { asyncHandler, badQuery, notFound, validationError, ApiError } from '../utils/errors.js';
import { validateOrderInput, validateEvidenceInput, ORDER_STATUSES, PAYMENT_STATUSES, SOURCES } from '../utils/validation.js';
import { getSettings } from '../services/settingsService.js';
import { riskMap, withRisk } from '../services/orderService.js';

const TERMINAL = ['completed', 'cancelled'];
const SORTS = { deadline: 1, '-deadline': -1, createdAt: 1, '-createdAt': -1 };
const ID = /^[a-f\d]{24}$/i;

async function findOrder(id) {
  if (!ID.test(id)) throw notFound('Order', id);
  const order = await Order.findById(id);
  if (!order) throw notFound('Order', id);
  return order;
}

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
  res.json({ items: orders.slice((page - 1) * pageSize, page * pageSize).map((o) => withRisk(o, risks)), page, pageSize, total: orders.length });
});

export const create = asyncHandler(async (req, res) => {
  const { value, details } = validateOrderInput(req.body);
  if (details.length) throw validationError(details);
  const order = await Order.create(value);
  const risks = await riskMap(await getSettings());
  res.status(201).location(`/api/orders/${order.id}`).json(withRisk(order, risks));
});

export const get = asyncHandler(async (req, res) => {
  const order = await findOrder(req.params.id);
  res.json(withRisk(order, await riskMap(await getSettings())));
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
  res.json(withRisk(order, await riskMap(await getSettings())));
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
