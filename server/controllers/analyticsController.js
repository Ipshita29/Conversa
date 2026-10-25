import Order from '../models/Order.js';
import { asyncHandler, badQuery } from '../utils/errors.js';
import { getSettings } from '../services/settingsService.js';
import { buildMonthly, isMonth, DATASETS } from '../services/analyticsService.js';
import { buildBoard } from '../services/boardService.js';
import { buildSummary, RANGES } from '../services/insightsService.js';
import { zonedParts } from '../utils/timezone.js';

export const getMonthly = asyncHandler(async (req, res) => {
  const settings = await getSettings();
  const now = new Date();
  const t = zonedParts(now, settings.timezone);
  const month = req.query.month ?? `${t.year}-${String(t.month).padStart(2, '0')}`;
  if (!isMonth(month)) throw badQuery([{ field: 'month', message: 'Must be a month in YYYY-MM format.' }]);
  const dataset = req.query.dataset ?? 'all';
  if (!DATASETS.includes(dataset)) throw badQuery([{ field: 'dataset', message: 'Must be real, demo or all.' }]);
  const orders = await Order.find().limit(5000).lean();
  res.json(buildMonthly({ orders: orders.map((o) => ({ ...o, id: String(o._id) })), settings, month, now, dataset }));
});

// GET /api/analytics/summary?range=7|30&dataset=all|real|demo : the Insights dashboard.
export const getSummary = asyncHandler(async (req, res) => {
  const days = req.query.range === undefined ? 7 : Number(req.query.range);
  if (!RANGES.includes(days)) throw badQuery([{ field: 'range', message: 'Must be 7 or 30.' }]);
  const dataset = req.query.dataset ?? 'all';
  if (!DATASETS.includes(dataset)) throw badQuery([{ field: 'dataset', message: 'Must be real, demo or all.' }]);
  const settings = await getSettings();
  const orders = await Order.find().limit(5000).lean();
  res.json(buildSummary({ orders: orders.map((o) => ({ ...o, id: String(o._id) })), settings, days, now: new Date(), dataset }));
});

// GET /api/board?dataset=all|real|demo : the Production board (overdue / on track / upcoming).
export const getBoard = asyncHandler(async (req, res) => {
  const dataset = req.query.dataset ?? 'all';
  if (!DATASETS.includes(dataset)) throw badQuery([{ field: 'dataset', message: 'Must be real, demo or all.' }]);
  const settings = await getSettings();
  const orders = await Order.find().limit(5000).lean();
  res.json(buildBoard({ orders: orders.map((o) => ({ ...o, id: String(o._id) })), settings, now: new Date(), dataset }));
});
