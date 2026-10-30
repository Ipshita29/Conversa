// The demo story: a small home bakery with five open orders that show how Conversa sorts work by urgency:
//   1 overdue (Meera), 2 on track (Rohan, Kabir), 2 upcoming (Neha, Aanya).
// Pure functions (no database), so the data can be tested at any time of day.
//
// Deadlines are placed on WORKING days relative to "now", at fixed clock times, so the picture is the same whenever it is seeded
// (on Sunday 25 Oct 2026 they are Sat 24 12:00, Mon 26 10:00, Mon 26 17:00, Tue 27 12:00 and Thu 29 17:00). The labels are NOT
// stored: the board derives them from these deadlines, the preparation times and the scheduler (see services/boardService.js).
//   Meera  - promised for the previous working day and still not delivered   -> OVERDUE
//   Neha   - due first thing on the next working day                         -> UPCOMING (prepare before less urgent orders)
//   Aanya  - due the next working day, late afternoon                        -> UPCOMING
//   Rohan  - due in two working days, with room to spare                     -> ON TRACK
//   Kabir  - due in four working days                                        -> ON TRACK
// Preparation times are what is LEFT to do: the cake bases and boxes are already made, so these are the finishing and packing times
// the scheduler has to fit in before each deadline.
import { zonedParts, zonedTimeToUtc, addDays, weekdayOf, parseHm } from '../utils/timezone.js';

export const DEMO_MARK = '[DEMO]';

// `back` > 0 counts working days backwards from today, `ahead` forwards (a non-working "today" is skipped, as the scheduler does).
const ORDERS = [
  { customerName: 'Meera Iyer', source: 'whatsapp', item: 'Wedding favour boxes', quantity: 50, customisation: 'Gold ribbon, names on tags', prepTimeMinutes: 30, price: 4500, createdHoursAgo: 120, due: { days: -1, at: '12:00' }, status: 'in_progress', paymentStatus: 'unverified', note: 'promised yesterday, still being finished' },
  { customerName: 'Rohan Mehta', source: 'instagram', item: 'Festive gift hampers', quantity: 3, customisation: null, prepTimeMinutes: 120, price: 2700, createdHoursAgo: 70, due: { days: 2, at: '12:00' }, status: 'confirmed', paymentStatus: 'partial', note: 'plenty of time' },
  { customerName: 'Kabir Singh', source: 'instagram', item: 'Custom cupcake tower', quantity: 1, customisation: 'Pistachio and rose, gold topper', prepTimeMinutes: 180, price: 3200, createdHoursAgo: 40, due: { days: 4, at: '17:00' }, status: 'confirmed', paymentStatus: 'pending', note: 'well ahead of the deadline' },
  { customerName: 'Aanya Sharma', source: 'whatsapp', item: 'Birthday cake (2 kg)', quantity: 1, customisation: 'Name and age in blue icing', prepTimeMinutes: 150, price: 1800, createdHoursAgo: 26, due: { days: 1, at: '17:00' }, status: 'confirmed', paymentStatus: 'verified', note: 'due the next working day' },
  { customerName: 'Neha Sharma', source: 'whatsapp', item: 'Chocolate birthday cake (2 kg)', quantity: 1, customisation: 'Dark chocolate ganache, no nuts', prepTimeMinutes: 30, price: 2200, createdHoursAgo: 8, due: { days: 1, at: '10:00' }, status: 'in_progress', paymentStatus: 'unverified', note: 'due first thing next working day' },
];

// The Nth working day from today (n < 0: before today). Weekdays outside settings.workingDays are skipped.
function workingDay(n, settings, now) {
  const t = zonedParts(now, settings.timezone);
  let day = { year: t.year, month: t.month, day: t.day };
  const step = n < 0 ? -1 : 1;
  for (let left = Math.abs(n); left > 0;) {
    day = addDays(day, step);
    if (settings.workingDays.includes(weekdayOf(day))) left--;
  }
  return day;
}

export function buildDemoOrders(settings, now = new Date()) {
  return ORDERS.map(({ due, note, createdHoursAgo, ...o }) => ({
    ...o,
    deadline: zonedTimeToUtc({ ...workingDay(due.days, settings, now), ...parseHm(due.at) }, settings.timezone),
    createdAt: new Date(now.getTime() - createdHoursAgo * 3600000),
    notes: `${DEMO_MARK} ${note}`,
  }));
}

// One inbound message per demo order, and nothing else: five conversations, each linked to the demo order of the same customer.
// The newest one (Neha asking for her cake first thing) is the single unread message.
export const DEMO_MESSAGES = [
  { customer: 'Meera Iyer', channel: 'whatsapp', order: 'Meera Iyer', hoursAgo: 30, read: true, text: 'Hi! Are the 50 wedding favour boxes ready? The sangeet is today.' },
  { customer: 'Rohan Mehta', channel: 'instagram', order: 'Rohan Mehta', hoursAgo: 9, read: true, text: 'Can you add one more hamper to my order? Same delivery day please.' },
  { customer: 'Kabir Singh', channel: 'instagram', order: 'Kabir Singh', hoursAgo: 5, read: true, text: 'Thank you for confirming the cupcake tower! Could the topper be gold?' },
  { customer: 'Aanya Sharma', channel: 'whatsapp', order: 'Aanya Sharma', hoursAgo: 3, read: true, text: 'Hi! Please write "Happy 30th, Ria" on the cake in blue icing.' },
  { customer: 'Neha Sharma', channel: 'whatsapp', order: 'Neha Sharma', hoursAgo: 0.5, read: false, text: 'Could the chocolate cake be ready by 10am tomorrow? We are leaving early for the party.' },
];

// Sample payments for the demo, one story each (all flagged isDemo, none of them verified against a real bank):
//   Aanya  - paid in full by UPI, confirmed, with a transaction ID
//   Rohan  - a deposit confirmed by bank transfer, the rest still to come (partially paid)
//   Meera  - nothing paid yet (payment due)
//   Neha   - cash on delivery, not collected yet
//   Kabir  - a UPI screenshot read from chat, waiting for the owner to verify
// `orders` carry their ids; the payment records point at them. Amounts come from each order's own price.
export function buildDemoPayments(orders, now = new Date()) {
  const at = (hoursAgo) => new Date(now.getTime() - hoursAgo * 3600000);
  const by = Object.fromEntries(orders.map((o) => [o.customerName, o]));
  const owner = 'Demo owner';
  const out = [];
  const add = (name, p) => by[name] && out.push({ orderId: by[name].id, kind: 'payment', isDemo: true, notes: null, ...p });
  add('Aanya Sharma', { amount: by['Aanya Sharma']?.price, method: 'upi', status: 'confirmed', transactionId: '426118830517', paidAt: at(24), source: 'chat_text', notes: 'Demo record. Paid via UPI.',
    review: { by: owner, at: at(23), confirmedAmount: by['Aanya Sharma']?.price, mode: 'confirmed', note: 'Checked in the UPI app.' },
    history: [{ at: at(24), action: 'extracted', by: null, note: 'Read from a chat message.' }, { at: at(23), action: 'confirmed', by: owner, note: 'Owner confirmed the money arrived (demo).' }] });
  add('Rohan Mehta', { amount: 1350, method: 'bank_transfer', status: 'confirmed', transactionId: 'NEFT26302918455', paidAt: at(60), source: 'manual', notes: 'Demo record. 50% deposit; balance on delivery.',
    review: { by: owner, at: at(60), confirmedAmount: 1350, mode: 'manual_entry', note: 'Entered by the owner as already received.' },
    history: [{ at: at(60), action: 'recorded', by: owner, note: 'Recorded as received by the owner.' }, { at: at(60), action: 'confirmed', by: owner, note: 'Owner confirmed the money arrived (demo).' }] });
  add('Neha Sharma', { amount: by['Neha Sharma']?.price, method: 'cod', status: 'pending', transactionId: null, paidAt: null, source: 'manual', notes: 'Demo record. Cash on delivery: collect when handing over the cake.',
    history: [{ at: at(8), action: 'recorded', by: null, note: 'COD: not collected yet.' }] });
  add('Kabir Singh', { amount: by['Kabir Singh']?.price, method: 'upi', status: 'pending', transactionId: '412398765431', paidAt: at(4), source: 'chat_screenshot', notes: 'Demo record. Read from a screenshot; not verified.',
    extraction: { method: 'vision', confidence: 0.82, needsReview: true, issues: ['Recipient name is partly hidden in the screenshot.', 'Time was read from a blurred line; check it.'], recipient: 'S***** C****** (partly hidden)', model: 'demo', extractedAt: at(4) },
    history: [{ at: at(4), action: 'extracted', by: null, note: 'Waiting for the owner to verify.' }] });
  return out;
}
