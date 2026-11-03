import Order from '../models/Order.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import { getSettings } from './settingsService.js';
import Payment from '../models/Payment.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemoOrders, buildAllDemoOrders, buildDemoPayments, demoVision, demoOwnerReview, DEMO_OWNER, DEMO_MARK, DEMO_CONVERSATIONS } from '../scripts/demo-data.js';
import { syncOrder } from './paymentService.js';
import { processMessageImage } from './paymentAutoDetect.js';
import { saveProof, deleteProof } from './proofStore.js';

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'demo');
const slug = (s) => s.toLowerCase().replace(/\W+/g, '-');
const TOTAL_MESSAGES = DEMO_CONVERSATIONS.reduce((n, c) => n + c.messages.length, 0);

const MARK = new RegExp(`^\\${DEMO_MARK}`);
const inHours = (h, now) => new Date(now.getTime() + h * 3600000);

// Replaces the demo orders with a fresh set placed relative to `now`. Real (non-demo) orders are never touched.
export async function reseedDemoOrders(now = new Date()) {
  const removed = (await Order.deleteMany({ notes: MARK })).deletedCount;
  await Payment.deleteMany({ isDemo: true });
  const created = await Order.insertMany(buildAllDemoOrders(await getSettings(), now));
  await reseedDemoPayments(created, now);
  return { removed, created };
}

// Sample payments for the demo orders (flagged isDemo). Real payments are never touched.
export async function reseedDemoPayments(orders, now = new Date()) {
  await Payment.deleteMany({ isDemo: true });
  const plain = orders.map((o) => ({ ...o.toObject?.() ?? o, id: String(o._id ?? o.id) })); // only the orders that need a sample payment record get one (see buildDemoPayments)
  const docs = buildDemoPayments(plain, now).map(({ orderId, ...p }) => ({ ...p, order: orderId, transactionKey: p.transactionId ? p.transactionId.toUpperCase() : null }));
  await Payment.insertMany(docs);
  for (const o of plain) await syncOrder(o.id);
}

// Removes ONLY records flagged as demo: demo conversations, their messages (and the stored pictures), and any demo message left without a
// conversation. Real conversations and messages are never matched.
export async function removeDemoMessages() {
  for (const m of await Message.find({ isDemo: true }).select('attachment').lean()) await deleteProof(m.attachment);
  const messages = (await Message.deleteMany({ isDemo: true })).deletedCount;
  const conversations = (await Conversation.deleteMany({ isDemo: true })).deletedCount;
  return { messages, conversations };
}

// Builds the five demo conversations and runs every payment screenshot through the real detection pipeline (matching, review, duplicates),
// with the preset reading standing in for the vision model. Run it after the demo orders and their payments exist. Deterministic: the same
// calls always leave the same messages, pictures and payments, because the old demo ones are removed first and ids are fixed per message.
export async function reseedDemoMessages(orders, now = new Date()) {
  await removeDemoMessages();
  await Payment.deleteMany({ isDemo: true, source: { $in: ['auto_screenshot', 'chat_screenshot'] } });
  for (const c of DEMO_CONVERSATIONS) {
    const order = orders.find((o) => o.customerName === c.order);
    const last = c.messages.reduce((m, x) => Math.min(m, x.hoursAgo), Infinity);
    const conv = await Conversation.create({ channel: c.channel, contactId: `demo-${c.channel}-${slug(c.customer)}`, customerName: c.customer, lastMessageAt: inHours(-last, now), isDemo: true, orderId: order?._id ?? null });
    const readings = {};
    for (const [i, m] of c.messages.entries()) {
      const at = inHours(-m.hoursAgo, now);
      const externalId = `demo-${slug(c.customer)}-${i + 1}`;
      const mine = m.from === 'business'; // the baker's own reply
      let attachment = null; let paymentScan = null;
      if (m.image) {
        const { file, contentType, size, sha256 } = await saveProof(await fs.readFile(path.join(ASSETS, m.image.file)), m.image.file);
        attachment = { file, contentType, size, sha256 };
        paymentScan = m.image.kind === 'payment' ? { state: 'processing', at, claimedAt: null } : { state: 'not_payment', reason: 'Demo reference picture.', at, claimedAt: at };
        if (m.image.reading) readings[externalId] = m.image.reading;
      }
      const msg = await Message.create({ conversation: conv._id, channel: c.channel, externalId, direction: mine ? 'outbound' : 'inbound', text: m.text, messageType: m.image ? 'image' : 'text', receivedAt: at, readAt: m.unread ? null : at, isDemo: true, attachment, paymentScan });
      if (m.image?.kind === 'payment') {
        await processMessageImage(msg._id, { read: async (_buf, claimed) => demoVision(readings[claimed.externalId], now) });
        if (m.image.ownerConfirmed) { // the demo owner has checked their account for this one: an explicit, recorded step, never the screenshot's doing
          const pay = await Payment.findOne({ messageId: String(msg._id), status: 'pending' });
          if (pay) await Payment.updateOne({ _id: pay._id }, { $set: { status: 'confirmed', review: demoOwnerReview(pay.amount, at) }, $push: { history: { at, action: 'confirmed', by: DEMO_OWNER, note: 'Owner confirmed the money arrived (demo). Checked manually; not verified with a bank.' } } });
        }
      }
    }
  }
  const ids = (await Order.find({ notes: MARK }).select('_id').lean()).map((o) => String(o._id));
  for (const id of ids) await syncOrder(id);
}

// The demo story is anchored to a calendar day: "Meera is 1 day overdue", "Neha is due tomorrow morning". When the day changes, those
// statements stop being true, so the demo orders are re-anchored. Messages and read-state are kept; only the order links are re-pointed.
// Real orders are never modified. Returns true when a refresh happened.
export async function refreshStaleDemo(now = new Date()) {
  const existing = await Order.find({ notes: MARK }).select('customerName deadline').lean();
  if (existing.length === 0) return false;
  const settings = await getSettings();
  const key = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: settings.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
  const expected = new Map(buildAllDemoOrders(settings, now).map((o) => [o.customerName, key(o.deadline)]));
  const current = new Map(existing.map((o) => [o.customerName, o.deadline ? key(o.deadline) : null]));
  // Exactly the intended orders: no extras, no duplicates (a Map would hide a second "Neha"), each on today's expected day.
  const same = existing.length === expected.size && expected.size === current.size && [...expected].every(([name, day]) => current.get(name) === day);
  const chats = new Set((await Conversation.find({ isDemo: true }).select('customerName').lean()).map((c) => c.customerName));
  const sameChats = chats.size === DEMO_CONVERSATIONS.length && DEMO_CONVERSATIONS.every((c) => chats.has(c.customer));
  const sameMessages = (await Message.countDocuments({ isDemo: true })) === TOTAL_MESSAGES; // an older, shorter demo is upgraded
  if (same && sameChats && sameMessages && await Payment.exists({ isDemo: true })) return false;
  // The orders moved to today, or the sample conversations changed: rebuild both together so messages, orders and payments stay in step.
  const { created } = await reseedDemoOrders(now);
  await reseedDemoMessages(created, now);
  return true;
}
