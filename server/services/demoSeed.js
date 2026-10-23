import Order from '../models/Order.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import { getSettings } from './settingsService.js';
import { buildDemoOrders, DEMO_MARK, DEMO_MESSAGES } from '../scripts/demo-data.js';
import { OPEN_STATUSES } from '../utils/validation.js';

const MARK = new RegExp(`^\\${DEMO_MARK}`);
const inHours = (h, now) => new Date(now.getTime() + h * 3600000);

async function realOpenOrders() {
  return Order.find({ status: { $in: OPEN_STATUSES }, notes: { $not: MARK } }).lean();
}

// Replaces the demo orders with a fresh set whose deadlines are placed from the scheduler's own finish times, as of `now`.
// Real (non-demo) orders are never touched, but they are part of the queue the story is built around.
export async function reseedDemoOrders(now = new Date()) {
  const removed = (await Order.deleteMany({ notes: MARK })).deletedCount;
  const created = await Order.insertMany(buildDemoOrders(await getSettings(), now, await realOpenOrders()));
  return { removed, created };
}

export async function reseedDemoMessages(orders, now = new Date()) {
  const oldConvs = await Conversation.find({ isDemo: true }).select('_id');
  await Message.deleteMany({ conversation: { $in: oldConvs.map((c) => c._id) } });
  await Conversation.deleteMany({ isDemo: true });
  for (const m of DEMO_MESSAGES) {
    const at = inHours(-m.hoursAgo, now);
    const conv = await Conversation.create({
      channel: m.channel, contactId: `demo-${m.channel}-${m.customer.toLowerCase().replace(/\W+/g, '-')}`, customerName: m.customer,
      lastMessageAt: at, isDemo: true, orderId: orders.find((o) => o.customerName === m.order)?._id ?? null,
    });
    await Message.create({ conversation: conv._id, channel: m.channel, externalId: `demo-${conv._id}`, text: m.text, receivedAt: at, readAt: m.read ? at : null, isDemo: true });
  }
}

// The demo story is anchored to the moment it was seeded: hours later its deadlines are in the past, every demo order is "overdue",
// and (because the scheduler works earliest-deadline-first) that backlog pushes newer, genuinely on-time orders days into the future.
// So when any OPEN demo order's deadline has passed, the demo orders are re-anchored to now. Messages and read-state are kept;
// only the order links are re-pointed. Real orders are never modified. Returns true when a refresh happened.
export async function refreshStaleDemo(now = new Date()) {
  const stale = await Order.exists({ notes: MARK, status: { $in: OPEN_STATUSES }, deadline: { $lt: now } });
  if (!stale) return false;
  const { created } = await reseedDemoOrders(now);
  for (const o of created) await Conversation.updateMany({ isDemo: true, customerName: o.customerName }, { $set: { orderId: o._id } });
  return true;
}
