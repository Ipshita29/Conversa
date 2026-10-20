// Seeds 5 DEMO orders and 6 DEMO inbox messages (5 read, 1 unread). WhatsApp/Instagram are NOT connected or simulated:
// the messages are plain stored records flagged isDemo.
//   npm run seed:demo    (re)creates the demo orders, with deadlines relative to NOW
//   npm run seed:clear   removes only the demo orders
// Demo orders are marked with notes starting "[DEMO]"; demo conversations/messages with isDemo. Nothing else is ever deleted.
// Run it right before presenting: risk depends on the current time and today's remaining capacity.
import mongoose from 'mongoose';
import { config } from '../config/env.js';
import Order from '../models/Order.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import { getSettings } from '../services/settingsService.js';
import { zonedParts, zonedTimeToUtc, addDays, weekdayOf, parseHm } from '../utils/timezone.js';

const MARK = '[DEMO]';
const inHours = (h) => new Date(Date.now() + h * 3600000);

// Deadline at HH:mm on the Nth WORKING day after today, in the business timezone (so the story holds at any time of day).
function workingDayAt(n, hm, settings) {
  const t = zonedParts(new Date(), settings.timezone);
  let day = { year: t.year, month: t.month, day: t.day };
  for (let left = n; left > 0;) {
    day = addDays(day, 1);
    if (settings.workingDays.includes(weekdayOf(day))) left--;
  }
  return zonedTimeToUtc({ ...day, ...parseHm(hm) }, settings.timezone);
}

// Story: Aanya and Rohan both want orders by tomorrow 17:00 and together they stretch the seller's capacity (-> risk);
// Priya has plenty of slack (-> low); Kabir has no prep estimate (-> needs details); Tara is done (-> excluded).
const demo = (st) => [
  { customerName: 'Aanya Sharma', source: 'whatsapp', item: 'Custom birthday cake (2 kg)', quantity: 1, customisation: 'Name and age in blue icing', prepTimeMinutes: 240, deadline: workingDayAt(1, '17:00', st), status: 'in_progress', paymentStatus: 'verified' },
  { customerName: 'Rohan Mehta', source: 'instagram', item: 'Gift hamper', quantity: 3, prepTimeMinutes: 420, deadline: workingDayAt(1, '17:00', st), status: 'confirmed', paymentStatus: 'pending' },
  { customerName: 'Priya Nair', source: 'whatsapp', item: 'Cupcake box', quantity: 24, prepTimeMinutes: 180, deadline: workingDayAt(3, '12:00', st), status: 'pending', paymentStatus: 'unverified' },
  { customerName: 'Kabir Singh', source: 'instagram', item: 'Custom portrait (A3)', quantity: 1, prepTimeMinutes: null, deadline: workingDayAt(4, '17:00', st), status: 'pending', paymentStatus: 'unverified' },
  { customerName: 'Tara Bose', source: 'manual', item: 'Sketch commission', quantity: 1, prepTimeMinutes: 240, deadline: inHours(-20), status: 'completed', paymentStatus: 'verified' },
].map((o) => ({ ...o, notes: `${MARK} sample order for demonstration` }));

// One inbound message per demo conversation. `order` links to the demo order of the same customer (if any).
// The last message (new rush request, no order yet) is the single unread one.
const messages = () => [
  { customer: 'Aanya Sharma', channel: 'whatsapp', order: 'Aanya Sharma', hoursAgo: 26, read: true, text: 'Hi! Just checking the birthday cake is still on for tomorrow. Could you write "Happy 30th Meera" on it?' },
  { customer: 'Rohan Mehta', channel: 'instagram', order: 'Rohan Mehta', hoursAgo: 9, read: true, text: 'Can you add one more hamper to my order? Same delivery day please.' },
  { customer: 'Priya Nair', channel: 'whatsapp', order: 'Priya Nair', hoursAgo: 5, read: true, text: "Thanks for confirming! I'll send the payment screenshot this evening." },
  { customer: 'Kabir Singh', channel: 'instagram', order: 'Kabir Singh', hoursAgo: 3, read: true, text: 'How long will the portrait take? I would love to gift it next Saturday.' },
  { customer: 'Tara Bose', channel: 'instagram', order: 'Tara Bose', hoursAgo: 1.5, read: true, text: 'Received the sketch. It is beautiful, thank you so much!' },
  { customer: 'Nikhil Rao', channel: 'whatsapp', order: null, hoursAgo: 0.3, read: false, text: 'Hi! Any chance of 30 cake pops by tomorrow noon? Happy to pay extra for a rush.' },
];

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
  const created = await Order.insertMany(demo(await getSettings()));
  await seedMessages(created);
  console.log(`Replaced ${removed} old demo order(s); created ${created.length} demo orders and ${messages().length} demo messages (5 read, 1 unread).`);
}
await mongoose.disconnect();
