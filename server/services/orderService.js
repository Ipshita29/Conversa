import Order from '../models/Order.js';
import { computePlan } from './workloadEngine.js';
import { OPEN_STATUSES } from '../utils/validation.js';

// Risk is computed over ALL open orders (not just one page) so each order's risk is consistent with the planner.
export async function riskMap(settings, now = new Date()) {
  const open = await Order.find({ status: { $in: OPEN_STATUSES } });
  return computePlan({ orders: open, settings, now }).results;
}

export const withRisk = (order, risks) => ({ ...order.toJSON(), risk: risks[order.id]?.risk ?? null });
