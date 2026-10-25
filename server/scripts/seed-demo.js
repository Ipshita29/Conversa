// Seeds the demo story (see demo-data.js): 5 DEMO orders for a home bakery plus 6 DEMO inbox messages (4 read, 1 unread).
// WhatsApp/Instagram are NOT connected or simulated: the messages are plain stored records flagged isDemo.
//   npm run seed:demo    (re)creates them, with deadlines placed from the scheduler's own finish times
//   npm run seed:clear   removes only the demo data
// Demo orders are marked with notes starting "[DEMO]"; demo conversations/messages with isDemo. Nothing else is ever deleted.
import mongoose from 'mongoose';
import { config } from '../config/env.js';
import Order from '../models/Order.js';
import { DEMO_MESSAGES, DEMO_MARK } from './demo-data.js';
import { reseedDemoOrders, reseedDemoMessages, removeDemoMessages } from '../services/demoSeed.js';

const MARK = DEMO_MARK;

if (!config.mongoUri) { console.error('MONGODB_URI is not set (see server/.env.example).'); process.exit(1); }
await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
if (process.argv.includes('--clear')) {
  const removed = (await Order.deleteMany({ notes: new RegExp(`^\\${MARK}`) })).deletedCount;
  const gone = await removeDemoMessages();
  console.log(`Removed ${removed} demo order(s) and ${gone.conversations} demo conversation(s) with ${gone.messages} message(s). Real data was not touched.`);
} else {
  // Real open orders (not demo) are part of the queue too, so the story is built around them.
  const { removed, created } = await reseedDemoOrders(new Date());
  await reseedDemoMessages(created, new Date());
  console.log(`Replaced ${removed} old demo order(s); created ${created.length} demo orders and ${DEMO_MESSAGES.length} demo messages (4 read, 1 unread).`);
}
await mongoose.disconnect();
