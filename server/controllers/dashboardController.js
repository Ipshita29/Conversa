import Order from '../models/Order.js';
import { asyncHandler } from '../utils/errors.js';
import { getSettings } from '../services/settingsService.js';
import { buildDashboard } from '../services/dashboardService.js';

export const getDashboard = asyncHandler(async (req, res) => {
  const [orders, settings] = await Promise.all([Order.find().limit(5000), getSettings()]);
  res.json(buildDashboard(orders, settings));
});
