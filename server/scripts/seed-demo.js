// Seeds the demo story (see demo-data.js): 5 DEMO orders for a home bakery plus 6 DEMO inbox messages (5 read, 1 unread).
// WhatsApp/Instagram are NOT connected or simulated: the messages are plain stored records flagged isDemo.
//   npm run seed:demo    (re)creates them, with deadlines placed from the scheduler's own finish times
//   npm run seed:clear   removes only the demo data
// Demo orders are marked with notes starting "[DEMO]"; demo conversations/messages with isDemo. Nothing else is ever deleted.
import mongoose from 'mongoose';
import { config } from '../config/env.js';
import Order from '../models/Order.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import { getSettings } from '../services/settingsService.js';
import { buildDemoOrders, DEMO_MESSAGES, DEMO_MARK } from './demo-data.js';

const MARK = DEMO_MARK;
const inHours = (h) => new Date(Date.now() + h * 3600000);
const messages = () => DEMO_MESSAGES;

async function seedMessages(orders) {
  const oldConvs = await Conversation.find({ isDemo: true }).select('_id');
  await Message.deleteMany({ conversation: { $in: oldConvs.map((c) => c._id) } });
  await Conversation.deleteMany({ isDemo: true });
  for (const m of messages()) {
    const at = inHours(-m.hoursAgo);
    const conv = await Conversation.create({
      channel: m.channel, contactId: `demo-${m.channel}-${m.customer.toLowerCase().replace(/\W+/g, '-')}`, customerName: m.customer,
      lastMessageAt: at, isDemo: true, orderId: orders.find((o) => o.customerName === m.order)?._id ?? null,
    });
    await Message.create({ conversation: conv._id, channel: m.channel, externalId: `demo-${conv._id}`, text: m.text, receivedAt: at, readAt: m.read ? at : null, isDemo: true });
  }
}

if (!config.mongoUri) { console.error('MONGODB_URI is not set (see server/.env.example).'); process.exit(1); }
await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
const removed = (await Order.deleteMany({ notes: new RegExp(`^\\${MARK}`) })).deletedCount;
if (process.argv.includes('--clear')) {
  const convs = await Conversation.find({ isDemo: true }).select('_id');
  await Message.deleteMany({ conversation: { $in: convs.map((c) => c._id) } });
  await Conversation.deleteMany({ isDemo: true });
  console.log(`Removed ${removed} demo order(s) and ${convs.length} demo conversation(s).`);
} else {
  // Real open orders (not demo) are part of the queue too, so the story is built around them.
  const realOpen = await Order.find({ status: { $in: ['pending', 'confirmed', 'in_progress'] } }).lean();
  const created = await Order.insertMany(buildDemoOrders(await getSettings(), new Date(), realOpen));
  await seedMessages(created);
  console.log(`Replaced ${removed} old demo order(s); created ${created.length} demo orders and ${messages().length} demo messages (5 read, 1 unread).`);
}
await mongoose.disconnect();
