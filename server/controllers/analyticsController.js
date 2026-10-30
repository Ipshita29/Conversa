import Order from '../models/Order.js';
import { asyncHandler, badQuery } from '../utils/errors.js';
import { getSettings } from '../services/settingsService.js';
import { buildMonthly, isMonth, DATASETS } from '../services/analyticsService.js';
import { buildBoard } from '../services/boardService.js';
import { buildSummary, checkCustomRange, RANGES } from '../services/insightsService.js';
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

// GET /api/analytics/summary?range=7|30|90&dataset=all|real|demo, or ?from=YYYY-MM-DD&to=YYYY-MM-DD for a custom period: the Insights dashboard.
export const getSummary = asyncHandler(async (req, res) => {
  const settings = await getSettings();
  const now = new Date();
  const dataset = req.query.dataset ?? 'all';
  if (!DATASETS.includes(dataset)) throw badQuery([{ field: 'dataset', message: 'Must be real, demo or all.' }]);
  let days = req.query.range === undefined ? 7 : Number(req.query.range);
  let custom;
  if (req.query.from !== undefined || req.query.to !== undefined) {
    const r = checkCustomRange(req.query.from, req.query.to, zonedParts(now, settings.timezone));
    if (r.details.length) throw badQuery(r.details);
    custom = { from: req.query.from, to: req.query.to };
  } else if (!RANGES.includes(days)) throw badQuery([{ field: 'range', message: `Must be one of ${RANGES.join(', ')}.` }]);
  const orders = await Order.find().limit(5000).lean();
  res.json(buildSummary({ orders: orders.map((o) => ({ ...o, id: String(o._id) })), settings, days, ...custom, now, dataset }));
});

// GET /api/board?dataset=all|real|demo : the Production board (overdue / on track / upcoming).
export const getBoard = asyncHandler(async (req, res) => {
  const dataset = req.query.dataset ?? 'all';
  if (!DATASETS.includes(dataset)) throw badQuery([{ field: 'dataset', message: 'Must be real, demo or all.' }]);
  const settings = await getSettings();
  const orders = await Order.find().limit(5000).lean();
  res.json(buildBoard({ orders: orders.map((o) => ({ ...o, id: String(o._id) })), settings, now: new Date(), dataset }));
});
