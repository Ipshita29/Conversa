// The demo story: a small home bakery on Tuesday 3 November 2026 with five open orders, two of them promised for the SAME time:
//   Aanya (60 min) and Kartik (30 min) both want delivery at 10:30, which one baker cannot do twice. The scheduler works out the rest.
// Nothing here states the schedule. Production starts at 9:00 (the What-if clock) and the engine places the work from each order's own deadline and
// preparation time: Kartik 9:00-9:30, Aanya 9:30-10:30, Rohan 10:30-11:30, the rush order 11:30-12:00, Meera 12:00-13:00.
// Pure functions (no database), so the data can be tested at any time of day.
//   Aanya  - chocolate cake (2 kg), 10:30, 60 min   payment screenshot
//   Kartik - 6 cupcakes, 10:30, 30 min              payment screenshot
//   Rohan  - pineapple cake, 12:00, 60 min          cash on delivery
//   Neha   - the existing rush order (chocolate cake, 2 kg), 12:00, 30 min   advance screenshot, balance on delivery
//   Meera  - 4 chocolate pastries, 14:00, 60 min    payment screenshot
import { zonedTimeToUtc, parseHm } from '../utils/timezone.js';

export const DEMO_MARK = '[DEMO]';
export const DEMO_DAY = { year: 2026, month: 11, day: 3 }; // the scenario's calendar day
export const DEMO_START = '09:00'; // production starts here: the clock the What-if page plans from

const ORDERS = [
  { customerName: 'Aanya Sharma', source: 'whatsapp', item: 'Chocolate cake (2 kg)', quantity: 1, customisation: 'Name and age in blue icing', prepTimeMinutes: 60, price: 1800, createdHoursAgo: 27, due: '10:30', status: 'confirmed', paymentStatus: 'verified', note: 'wants delivery at 10:30' },
  { customerName: 'Kartik Singh', source: 'instagram', item: '6 cupcakes', quantity: 6, customisation: 'Pistachio and rose, gold topper', prepTimeMinutes: 30, price: 720, createdHoursAgo: 31, due: '10:30', status: 'confirmed', paymentStatus: 'unverified', note: 'also wants delivery at 10:30, ordered first' },
  { customerName: 'Rohan Mehta', source: 'instagram', item: 'Pineapple cake', quantity: 1, customisation: 'Handwritten card', prepTimeMinutes: 60, price: 1100, createdHoursAgo: 40, due: '12:00', status: 'confirmed', paymentStatus: 'pending', note: 'cash on delivery' },
  { customerName: 'Neha Sharma', source: 'whatsapp', item: 'Chocolate birthday cake (2 kg)', quantity: 1, customisation: 'Dark chocolate ganache, no nuts', prepTimeMinutes: 30, price: 2200, createdHoursAgo: 8, due: '12:00', status: 'in_progress', paymentStatus: 'unverified', note: 'the existing rush order' },
  { customerName: 'Meera Iyer', source: 'whatsapp', item: '4 chocolate pastries', quantity: 4, customisation: null, prepTimeMinutes: 60, price: 640, createdHoursAgo: 120, due: '14:00', status: 'confirmed', paymentStatus: 'unverified', note: 'due early afternoon' },
];

// The moment production starts on the scenario day (in the business timezone): the clock the What-if page plans from.
export const demoClock = (settings) => zonedTimeToUtc({ ...DEMO_DAY, ...parseHm(DEMO_START) }, settings.timezone);
export const buildAllDemoOrders = (settings, now = new Date()) => buildDemoOrders(settings, now);

export function buildDemoOrders(settings, now = new Date()) {
  return ORDERS.map(({ due, note, createdHoursAgo, ...o }) => ({
    ...o,
    deadline: zonedTimeToUtc({ ...DEMO_DAY, ...parseHm(due) }, settings.timezone),
    createdAt: new Date(now.getTime() - createdHoursAgo * 3600000),
    notes: `${DEMO_MARK} ${note}`,
  }));
}

// The demo conversations: one per demo order, written as a real customer and a home baker would chat: an enquiry, the baker asking what is
// needed, the price and delivery agreed, a reference picture, customisation, a payment and the baker confirming.
// Every figure matches the demo order it belongs to (price, quantity, deadline) and every picture matches its own order. Everything here is DEMO DATA:
// nothing is a live WhatsApp or Instagram message, and the Messages page says so.
//
// `hoursAgo` places each message relative to "now". `from: 'business'` marks the baker's replies; everything else is the customer.
// `image` is a file in server/assets/demo; `kind` is 'reference' (what the customer wants) or 'payment' (a screenshot). A payment picture
// carries `reading`, the preset result of reading it (there is no vision model in the demo), which goes through the SAME matching, review and
// duplicate rules as a real screenshot. A screenshot never verifies anything: `ownerConfirmed` records that the demo owner has since checked
// their account for that payment (a separate, explicit step).
//   Aanya  - full amount by UPI, confirmed by the owner; wants delivery at 10:30; changes the cake message after ordering
//   Kartik - full amount by UPI, waiting for verification; also wants 10:30
//   Rohan  - pays cash on delivery: no screenshot
//   Neha   - the rush order: advance of half the price by UPI, the balance on delivery
//   Meera  - advance by UPI whose screenshot is too blurry to read a reference -> Pending Review
const b = (hoursAgo, text) => ({ from: 'business', hoursAgo, text });
const reading = (amount, transactionId, paidHoursAgo, confidence, uncertainties = []) => ({ amount, transactionId, paidHoursAgo, method: 'upi', recipient: 'S***** C****** (partly hidden)', confidence, uncertainties });
export const DEMO_CONVERSATIONS = [
  { customer: 'Aanya Sharma', channel: 'whatsapp', order: 'Aanya Sharma', messages: [
    { hoursAgo: 29, text: "Hello! Do you make chocolate cakes? It's for my sister's birthday." },
    b(28.9, 'Hi Aanya! Yes we do 🎂 What size are you thinking?'),
    { hoursAgo: 28.7, text: 'A 2 kg chocolate cake please.' },
    { hoursAgo: 28.4, text: 'This is the one I like.', image: { file: 'ref-aanya-cake.png', kind: 'reference' } },
    b(28.1, 'Lovely choice! A 2 kg chocolate cake is ₹1,800. Would you like a message on it?'),
    { hoursAgo: 27.9, text: 'Please write "Happy Birthday Ria" in blue icing.' },
    b(27.7, 'Done. When do you need it?'),
    { hoursAgo: 27.5, text: 'Delivery at 10:30 AM on 3 November please. Let\'s go ahead!' },
    b(27.3, 'Noted, 10:30 AM on 3 November. You can pay the full amount on UPI to sweetcrumbs@upi.'),
    { hoursAgo: 26.6, text: 'Oops, change the message to "Happy Birthday Riya" please.' },
    b(26.4, 'No problem, updated to "Happy Birthday Riya" 🙂'),
    { hoursAgo: 24.1, text: 'Paid ₹1,800 via UPI. UTR 426118830517', image: { file: 'pay-aanya-upi.png', kind: 'payment', ownerConfirmed: true, reading: reading(1800, '426118830517', 24.15, 0.94) } },
    b(24, 'Received, thank you! Your order is confirmed.'),
    { hoursAgo: 3, text: 'Thank you! See you at 10:30.' },
  ] },
  { customer: 'Kartik Singh', channel: 'instagram', order: 'Kartik Singh', messages: [
    { hoursAgo: 33.5, text: 'Hi! Do you make cupcakes in small batches?' },
    b(33.3, 'Hey Kartik! Yes. How many, and what flavours?'),
    { hoursAgo: 33, text: "I'd like 6 cupcakes, pistachio and rose flavour." },
    { hoursAgo: 32.9, text: 'Something like this please 🙏', image: { file: 'ref-kartik-cupcakes.png', kind: 'reference' } },
    b(32.6, '6 cupcakes like these are ₹720. Anything special on top?'),
    { hoursAgo: 32.3, text: 'A gold topper on each. And I need them at 10:30 AM on 3 November.' },
    b(32, 'Gold toppers noted, delivery at 10:30 AM on 3 November. Shall I confirm?'),
    { hoursAgo: 31.7, text: 'Yes, confirm it.' },
    b(31.5, 'Please pay ₹720 on UPI to sweetcrumbs@upi and send me the screenshot.'),
    { hoursAgo: 31, text: 'Payment done, thank you!', image: { file: 'pay-kabir-upi.png', kind: 'payment', reading: reading(720, '412398765431', 31.1, 0.82, ['Recipient name is partly hidden in the screenshot.']) } },
    b(30.8, 'Received, thank you! Your order is confirmed ✅'),
  ] },
  { customer: 'Rohan Mehta', channel: 'instagram', order: 'Rohan Mehta', messages: [
    { hoursAgo: 40, text: 'Hi! Do you make pineapple cakes?' },
    b(39.8, 'Hi Rohan! Yes, we do. What size would you like?'),
    { hoursAgo: 39.5, text: 'A regular pineapple cake, like this one.', image: { file: 'ref-rohan-pineapple.png', kind: 'reference' } },
    b(39.2, 'Lovely! A pineapple cake like this is ₹1,100. Anything else to add?'),
    { hoursAgo: 38.8, text: 'Please add a handwritten card.' },
    b(38.5, 'Of course. When do you need it by?'),
    { hoursAgo: 38.2, text: 'Delivery by 12:00 noon on 3 November please. Can I pay cash on delivery?' },
    b(38, 'Yes, cash on delivery is fine. Noon on 3 November it is, ₹1,100 to collect. Your order is confirmed.'),
    { hoursAgo: 9, text: 'Thank you! Noon delivery is perfect.' },
  ] },
  { customer: 'Neha Sharma', channel: 'whatsapp', order: 'Neha Sharma', messages: [
    { hoursAgo: 10.4, text: 'Hi! I wanted to order a customised birthday cake for my nephew. Do you take orders for today?' },
    b(10.3, 'Hi Neha! Yes, absolutely 😊 What kind of cake are you looking for?'),
    { hoursAgo: 10.2, text: 'I want a 2 kg chocolate birthday cake. I have a reference picture too.' },
    { hoursAgo: 10.1, text: 'Something like this.', image: { file: 'ref-neha-cake.png', kind: 'reference' } },
    b(10, 'That looks lovely, we can make that! A 2 kg chocolate cake is ₹2,200. Would you like a message or any decorations?'),
    { hoursAgo: 9.8, text: 'Yes please! Write "Happy Birthday Laddu" on it in blue icing.' },
    b(9.7, "Perfect, I'll follow the reference and add the message in blue. When do you need it by?"),
    { hoursAgo: 9.5, text: 'I need it by 12pm today.' },
    b(9.4, 'Noon works. I will have it ready for 12.'),
    { hoursAgo: 9.2, text: 'Dark chocolate ganache please, and no nuts. My nephew is allergic.' },
    b(9, "Noted, ganache and no nuts. I'll keep it completely nut-free."),
    { hoursAgo: 8.9, text: "That works! Let's confirm the order." },
    b(8.8, 'Great! To confirm, please pay an advance of ₹1,100 on UPI to sweetcrumbs@upi. The balance of ₹1,100 is on delivery.'),
    { hoursAgo: 8.3, text: 'Done! Sending the screenshot.', image: { file: 'pay-neha-advance.png', kind: 'payment', reading: reading(1100, '508234917362', 8.35, 0.92, ['Recipient name is partly hidden in the screenshot.']) } },
    b(8.2, "Received, thank you! Your order is confirmed. I'll keep you updated."),
    { hoursAgo: 0.5, unread: true, text: "Hi! Just checking the cake will be ready by 12 noon? We're leaving early for the party." },
  ] },
  { customer: 'Meera Iyer', channel: 'whatsapp', order: 'Meera Iyer', messages: [
    { hoursAgo: 126, text: 'Hello! Do you make chocolate pastries?' },
    b(125.8, 'Hi Meera! Yes, we do. How many would you like?'),
    { hoursAgo: 125, text: 'I need 4 chocolate pastries.' },
    { hoursAgo: 124.9, text: 'Something like this.', image: { file: 'ref-meera-pastries.png', kind: 'reference' } },
    b(124.5, '4 chocolate pastries like these are ₹640. When would you like them?'),
    { hoursAgo: 124, text: 'Delivery by 2:00 PM on 3 November please.' },
    b(123.5, 'Done! To confirm, please pay an advance of ₹320 on UPI to sweetcrumbs@upi.'),
    { hoursAgo: 119.5, text: 'Sent the advance.', image: { file: 'pay-meera-advance.png', kind: 'payment', reading: reading(320, null, 119.6, 0.45, ['The image is blurry.', 'The reference line is cropped out.']) } },
    b(119.3, "Thanks Meera! The screenshot is a bit blurry and I can't see the reference number. Could you resend it?"),
    { hoursAgo: 30, text: 'Hi! Are the 4 pastries still on for 2 PM on the 3rd?' },
  ] },
];

// The owner's own check, recorded for demo payments the demo owner has verified (see `ownerConfirmed`). Never produced by reading a screenshot.
export const DEMO_OWNER = 'Demo owner';
export const demoOwnerReview = (amount, at) => ({ by: DEMO_OWNER, at, confirmedAmount: amount, mode: 'confirmed', note: 'Checked in the bank or UPI app (demo).' });

// What the vision reader would return for a demo payment picture (same shape as services/paymentExtraction.js validateVisionOutput).
export const demoVision = (reading, now = new Date()) => ({
  isPaymentScreenshot: true, amount: reading.amount, transactionId: reading.transactionId, paidAt: new Date(now.getTime() - reading.paidHoursAgo * 3600000),
  method: reading.method, recipient: reading.recipient, succeeded: true, confidence: reading.confidence, uncertainties: reading.uncertainties, model: 'demo (preset reading)',
});

// Sample payments for the demo, one story each (all flagged isDemo, none of them verified against a real bank):
//   Neha   - the balance (half the price) in cash on delivery, not collected yet; her advance is a screenshot in her chat
//   Rohan  - the whole price in cash on delivery, not collected yet (no screenshot)
//   Everyone else's payments are NOT listed here: they are read from the screenshots in their conversations (see DEMO_CONVERSATIONS)
// `orders` carry their ids; the payment records point at them. Amounts come from each order's own price.
export function buildDemoPayments(orders, now = new Date()) {
  const at = (hoursAgo) => new Date(now.getTime() - hoursAgo * 3600000);
  const by = Object.fromEntries(orders.map((o) => [o.customerName, o]));
  const out = [];
  const add = (name, p) => by[name] && out.push({ orderId: by[name].id, kind: 'payment', isDemo: true, notes: null, ...p });
  add('Neha Sharma', { amount: (by['Neha Sharma']?.price ?? 0) / 2, method: 'cod', status: 'pending', transactionId: null, paidAt: null, source: 'manual', notes: 'Demo record. Balance in cash on delivery: collect when handing over the cake.',
    history: [{ at: at(8), action: 'recorded', by: null, note: 'COD: not collected yet.' }] });
  add('Rohan Mehta', { amount: by['Rohan Mehta']?.price ?? 0, method: 'cod', status: 'pending', transactionId: null, paidAt: null, source: 'manual', notes: 'Demo record. Cash on delivery: collect when handing over the cake.',
    history: [{ at: at(38), action: 'recorded', by: null, note: 'COD: not collected yet.' }] });
  return out;
}
