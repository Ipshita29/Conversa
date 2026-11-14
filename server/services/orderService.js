import Order from '../models/Order.js';
import { computePlan } from './workloadEngine.js';
import { OPEN_STATUSES } from '../utils/validation.js';

// Risk is computed over ALL open orders (not just one page) so each order's risk is consistent with the planner.
export async function riskMap(settings, now = new Date()) {
  const open = await Order.find({ status: { $in: OPEN_STATUSES } });
  return computePlan({ orders: open, settings, now }).results;
}

// Requests that came in through chat and are still drafts: they are real, but not yet commitments, so the Plan, What-if and Insights do not count them
// until the owner confirms. This is what those pages report instead of silently leaving them out.
// What a request still lacks to be planned, read from the order ITSELF (never from what an earlier reading of the chat reported, which goes stale the moment
// the owner or a later message fills a field in).
const blankField = (v) => v === null || v === undefined || v === '';
export const missingForPlan = (o) => [
  ...(blankField(o.item) ? ['item'] : []),
  ...(typeof o.quantity !== 'number' || !(o.quantity >= 1) ? ['quantity'] : []),
  ...(blankField(o.deadline) || Number.isNaN(new Date(o.deadline).getTime()) ? ['deadline'] : []),
  ...(typeof o.prepTimeMinutes !== 'number' || !(o.prepTimeMinutes > 0) ? ['prepTimeMinutes'] : []),
];

// A draft the OWNER has reviewed (edited) and that now has everything the scheduler needs becomes a normal confirmed order, so it joins the Plan, What-if and
// Insights without a second step. A draft nobody has touched stays a draft however complete it looks. Nothing is invented: it only fires when every field is
// really there. Called when the owner supplies a scheduling field, and on request for drafts that were already reviewed and complete. Returns the ids promoted.
export async function promoteReadyDrafts({ orderId = null, reviewed = false } = {}) {
  const q = { status: 'draft', ...(orderId ? { _id: orderId } : { 'draft.ownerEdited': true }) };
  const done = [];
  for (const o of await Order.find(q).lean()) {
    if (!orderId && !reviewed && !o.draft?.ownerEdited) continue;
    if (missingForPlan(o).length) continue;
    const r = await Order.updateOne({ _id: o._id, status: 'draft' }, { $set: { status: 'confirmed', 'draft.promotedAt': new Date() } });
    if (r.modifiedCount) done.push(String(o._id));
  }
  return done;
}

export async function awaitingConfirmation() {
  const drafts = await Order.find({ status: 'draft' }).select('customerName item quantity deadline prepTimeMinutes source draft').sort({ createdAt: -1 }).limit(50).lean();
  return drafts.map((d) => ({ id: String(d._id), customerName: d.customerName, item: d.item, quantity: d.quantity, source: d.source, deadline: d.deadline ?? null, missing: missingForPlan(d).filter((f) => f !== 'prepTimeMinutes' || d.prepTimeMinutes == null) }));
}

export const withRisk = (order, risks) => ({ ...order.toJSON(), risk: risks[order.id]?.risk ?? null });
