import Order from '../models/Order.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import { getSettings } from './settingsService.js';
import { buildDemoOrders, DEMO_MARK, DEMO_MESSAGES } from '../scripts/demo-data.js';

const MARK = new RegExp(`^\\${DEMO_MARK}`);
const inHours = (h, now) => new Date(now.getTime() + h * 3600000);

// Replaces the demo orders with a fresh set placed relative to `now`. Real (non-demo) orders are never touched.
export async function reseedDemoOrders(now = new Date()) {
  const removed = (await Order.deleteMany({ notes: MARK })).deletedCount;
  const created = await Order.insertMany(buildDemoOrders(await getSettings(), now));
  return { removed, created };
}

// Removes ONLY records flagged as demo: demo conversations, their messages, and any demo message left without a conversation.
// Real conversations and messages are never matched.
export async function removeDemoMessages() {
  const messages = (await Message.deleteMany({ isDemo: true })).deletedCount;
  const conversations = (await Conversation.deleteMany({ isDemo: true })).deletedCount;
  return { messages, conversations };
}

export async function reseedDemoMessages(orders, now = new Date()) {
  await removeDemoMessages();
  for (const m of DEMO_MESSAGES) {
    const at = inHours(-m.hoursAgo, now);
    const conv = await Conversation.create({
      channel: m.channel, contactId: `demo-${m.channel}-${m.customer.toLowerCase().replace(/\W+/g, '-')}`, customerName: m.customer,
      lastMessageAt: at, isDemo: true, orderId: orders.find((o) => o.customerName === m.order)?._id ?? null,
    });
    await Message.create({ conversation: conv._id, channel: m.channel, externalId: `demo-${conv._id}`, text: m.text, receivedAt: at, readAt: m.read ? at : null, isDemo: true });
  }
}

// The demo story is anchored to a calendar day: "Meera is 1 day overdue", "Neha is due tomorrow morning". When the day changes, those
// statements stop being true, so the demo orders are re-anchored. Messages and read-state are kept; only the order links are re-pointed.
// Real orders are never modified. Returns true when a refresh happened.
export async function refreshStaleDemo(now = new Date()) {
  const existing = await Order.find({ notes: MARK }).select('customerName deadline').lean();
  if (existing.length === 0) return false;
  const settings = await getSettings();
  const key = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: settings.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
  const expected = new Map(buildDemoOrders(settings, now).map((o) => [o.customerName, key(o.deadline)]));
  const current = new Map(existing.map((o) => [o.customerName, o.deadline ? key(o.deadline) : null]));
  // Exactly the five intended orders: no extras, no duplicates (a Map would hide a second "Neha"), each on today's expected day.
  const same = existing.length === expected.size && expected.size === current.size && [...expected].every(([name, day]) => current.get(name) === day);
  const chats = new Set((await Conversation.find({ isDemo: true }).select('customerName').lean()).map((c) => c.customerName));
  const sameChats = chats.size === DEMO_MESSAGES.length && DEMO_MESSAGES.every((m) => chats.has(m.customer));
  if (same && sameChats) return false;
  const { created } = await reseedDemoOrders(now);
  if (sameChats) for (const o of created) await Conversation.updateMany({ isDemo: true, customerName: o.customerName }, { $set: { orderId: o._id } });
  else await reseedDemoMessages(created, now); // the sample conversations changed too: start them from the new story
  return true;
}
