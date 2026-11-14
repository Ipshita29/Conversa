import Order from '../models/Order.js';
import Message from '../models/Message.js';
import Conversation from '../models/Conversation.js';
import Payment from '../models/Payment.js';
import { buildStory } from '../services/insightsStory.js';
import { picturesOf } from './orderController.js';
import { awaitingConfirmation } from '../services/orderService.js';
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
  const orders = await Order.find({ status: { $ne: 'draft' } }).limit(5000).lean();
  res.json(buildMonthly({ orders: orders.map((o) => ({ ...o, id: String(o._id) })), settings, month, now, dataset }));
});

// The Insights story: the same orders, plus who wrote in (conversations) and what has actually been collected (confirmed payments).
async function storyFor({ orders, settings, summary, now, week }) {
  if (week !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(week))) throw badQuery([{ field: 'week', message: 'Must be a date in YYYY-MM-DD format.' }]);
  const dates = summary.trend.map((d) => d.date); const first = dates[0];
  const days = dates.length; const prevFrom = new Date(`${first}T00:00:00Z`); prevFrom.setUTCDate(prevFrom.getUTCDate() - days - 1);
  const prevDates = Array.from({ length: days }, (_, i) => { const d = new Date(prevFrom); d.setUTCDate(d.getUTCDate() + 1 + i); return d.toISOString().slice(0, 10); });
  const since = new Date(prevFrom.getTime() - 86400000);
  const msgs = await Message.find({ direction: 'inbound', receivedAt: { $gte: since } }).select('conversation receivedAt').limit(50000).lean();
  const convDocs = await Conversation.find({ _id: { $in: [...new Set(msgs.map((m) => String(m.conversation)))] } }).select('channel contactId orderId').lean();
  const linked = await Order.find({ _id: { $in: convDocs.map((c) => c.orderId).filter(Boolean) } }).select('customerContact').lean();
  const contactOf = Object.fromEntries(linked.map((o) => [String(o._id), o.customerContact]));
  const conversations = Object.fromEntries(convDocs.map((c) => [String(c._id), { channel: c.channel, contactId: c.contactId, orderContact: c.orderId ? contactOf[String(c.orderId)] ?? null : null }]));
  const pays = await Payment.find({ status: 'confirmed' }).select('order amount kind').lean(); const collected = {};
  for (const p of pays) if (p.order) collected[String(p.order)] = (collected[String(p.order)] ?? 0) + (p.kind === 'refund' ? -p.amount : p.amount);
  const story = buildStory({ orders, inbound: msgs.map((m) => ({ conversationId: String(m.conversation), at: m.receivedAt })), conversations, collected, settings, dates, prevDates, weekStart: week, now });
  if (story.popular.available) { // a picture only if one of those orders really has one (its own or one the customer sent)
    const pics = await picturesOf(await Order.find({ _id: { $in: story.popular.orderIds } }).sort({ createdAt: -1 }));
    const hit = story.popular.orderIds.map((id) => pics[id]?.[0]).find(Boolean);
    story.popular.image = hit ? { url: hit.url } : null;
  }
  delete story.popular.orderIds;
  return story;
}

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
  const orders = await Order.find({ status: { $ne: 'draft' } }).limit(5000).lean();
  const summary = buildSummary({ orders: orders.map((o) => ({ ...o, id: String(o._id) })), settings, days, ...custom, now, dataset });
  res.json({ ...summary, awaiting: await awaitingConfirmation(), story: await storyFor({ orders, settings, summary, now, week: req.query.week }) });
});

// GET /api/board?dataset=all|real|demo : the Production board (overdue / on track / upcoming).
export const getBoard = asyncHandler(async (req, res) => {
  const dataset = req.query.dataset ?? 'all';
  if (!DATASETS.includes(dataset)) throw badQuery([{ field: 'dataset', message: 'Must be real, demo or all.' }]);
  const settings = await getSettings();
  const orders = await Order.find({ status: { $ne: 'draft' } }).limit(5000).lean();
  res.json(buildBoard({ orders: orders.map((o) => ({ ...o, id: String(o._id) })), settings, now: new Date(), dataset }));
});
