import Order from '../models/Order.js';
import { asyncHandler, badQuery } from '../utils/errors.js';
import { getSettings } from '../services/settingsService.js';
import { buildMonthly, isMonth } from '../services/analyticsService.js';
import { zonedParts } from '../utils/timezone.js';

export const getMonthly = asyncHandler(async (req, res) => {
  const settings = await getSettings();
  const now = new Date();
  const t = zonedParts(now, settings.timezone);
  const month = req.query.month ?? `${t.year}-${String(t.month).padStart(2, '0')}`;
  if (!isMonth(month)) throw badQuery([{ field: 'month', message: 'Must be a month in YYYY-MM format.' }]);
  const orders = await Order.find().limit(5000).lean();
  res.json(buildMonthly({ orders: orders.map((o) => ({ ...o, id: String(o._id) })), settings, month, now }));
});
