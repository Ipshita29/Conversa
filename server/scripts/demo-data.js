// The demo story: a small home bakery with five orders that show every state Conversa can describe.
// Pure functions (no database), so the data can be tested at any time of day.
//
// The deadlines are not guessed. They are placed relative to the scheduler's OWN finish times, so the story holds
// whenever you seed it (morning, evening, Sunday...):
//   1. Aanya's birthday cake  - in progress, finishes comfortably early               -> ON TRACK
//   2. Rohan's gift hampers   - fits, but with only half the safety buffer             -> TIGHT (medium risk)
//   3. Meera's wedding favours - asked for a date the queue cannot meet               -> LATE (high risk)
//   4. Kabir's cupcake tower  - flavours and design not confirmed, so no prep time     -> NEEDS DETAILS
//   5. Tara's brownie tray    - delivered and paid                                     -> DONE
import { computePlan } from '../services/workloadEngine.js';
import { zonedParts, zonedTimeToUtc, addDays, weekdayOf, parseHm } from '../utils/timezone.js';

export const DEMO_MARK = '[DEMO]';
const MIN = 60000;

const QUEUE = [ // in scheduling order
  { customerName: 'Aanya Sharma', source: 'whatsapp', item: 'Birthday cake (2 kg)', quantity: 1, customisation: 'Name and age in blue icing', prepTimeMinutes: 240, status: 'in_progress', paymentStatus: 'verified', note: 'already started, finishes comfortably early' },
  { customerName: 'Rohan Mehta', source: 'instagram', item: 'Festive gift hampers', quantity: 3, customisation: null, prepTimeMinutes: 300, status: 'confirmed', paymentStatus: 'pending', note: 'fits, but with a thin buffer' },
  { customerName: 'Meera Iyer', source: 'whatsapp', item: 'Wedding favour boxes', quantity: 50, customisation: 'Gold ribbon, names on tags', prepTimeMinutes: 300, status: 'pending', paymentStatus: 'unverified', note: 'customer asked for a date the queue cannot meet' },
];

// Deadline at HH:mm on the Nth WORKING day after `now`, in the business timezone.
function workingDayAt(n, hm, settings, now) {
  const t = zonedParts(now, settings.timezone);
  let day = { year: t.year, month: t.month, day: t.day };
  for (let left = n; left > 0;) {
    day = addDays(day, 1);
    if (settings.workingDays.includes(weekdayOf(day))) left--;
  }
  return zonedTimeToUtc({ ...day, ...parseHm(hm) }, settings.timezone);
}

const roundTo5 = (ms) => Math.round(ms / (5 * MIN)) * 5 * MIN;

// `others` are the open orders already in the database (real ones). They are scheduled too, so the demo story still holds
// when a real order is in the queue ahead of it.
export function buildDemoOrders(settings, now = new Date(), others = []) {
  const buf = settings.riskBufferMinutes;
  const real = others.map((o, i) => ({ customerName: o.customerName, item: o.item, status: o.status, paymentStatus: o.paymentStatus, prepTimeMinutes: o.prepTimeMinutes ?? null, deadline: o.deadline ?? null, id: `x${i}` }));

  // Place the three queued deadlines relative to the scheduler's OWN finish times: comfortable (+buffer+2h), tight (half the
  // buffer), 100 min short. Real orders can sit in front of or behind these, which changes the finish times, so repeat
  // until the deadlines and the schedule they produce agree (a fixed point; it settles in a pass or two).
  const offsets = [buf + 120, Math.round(buf / 2), -100];
  let deadlines = QUEUE.map((_, i) => new Date(now.getTime() + (30 + i) * 86400000)); // far, ascending: a first guess
  for (let pass = 0; pass < 8; pass++) {
    const trial = QUEUE.map((o, i) => ({ ...o, id: `q${i}`, deadline: deadlines[i] }));
    const plan = computePlan({ orders: [...real, ...trial], settings, now, rangeDays: 7 });
    const finish = Object.fromEntries(plan.schedule.map((e) => [e.orderId, Date.parse(e.scheduledEnd)]));
    const next = QUEUE.map((_, i) => new Date(roundTo5(finish[`q${i}`] + offsets[i] * MIN)));
    const settled = next.every((d, i) => Math.abs(d - deadlines[i]) <= 5 * MIN);
    deadlines = next;
    if (settled) break;
  }
  const queued = QUEUE.map((o, i) => ({ ...o, deadline: deadlines[i] }));

  const orders = [
    ...queued,
    { customerName: 'Kabir Singh', source: 'instagram', item: 'Custom cupcake tower', quantity: 1, customisation: 'Flavours and theme still to be confirmed', prepTimeMinutes: null, deadline: workingDayAt(4, '17:00', settings, now), status: 'pending', paymentStatus: 'unverified', note: 'cannot be scheduled until the details are confirmed' },
    { customerName: 'Tara Bose', source: 'manual', item: 'Brownie tray', quantity: 2, customisation: null, prepTimeMinutes: 90, deadline: new Date(now.getTime() - 20 * 60 * MIN), status: 'completed', paymentStatus: 'verified', note: 'delivered and paid' },
  ].map(({ note, ...o }) => ({ ...o, notes: `${DEMO_MARK} ${note}` }));

  // Fail loudly if the story ever stops holding (judged on the demo orders only; real orders may be late themselves).
  const plan = computePlan({ orders: [...real, ...orders.map((o, i) => ({ ...o, id: `d${i}` }))], settings, now, rangeDays: 7 });
  const demoKinds = plan.schedule.filter((e) => e.orderId.startsWith('d')).map((e) => e.kind).join(',');
  const demoBlocked = plan.unscheduledOrders.filter((u) => u.id.startsWith('d')).length;
  if (demoKinds !== 'on_track,tight,late' || demoBlocked !== 1) {
    throw new Error(`Demo data would not tell its story (got "${demoKinds}", ${demoBlocked} needing details). A real open order may have a deadline that falls between the demo deadlines; mark it completed or cancelled first.`);
  }
  return orders;
}

// One inbound message per demo conversation; `order` links to the demo order of the same customer.
// The last one (a new rush request with no order yet) is the single unread message.
export const DEMO_MESSAGES = [
  { customer: 'Aanya Sharma', channel: 'whatsapp', order: 'Aanya Sharma', hoursAgo: 26, read: true, text: 'Hi! Is the cake still on track? Please write "Happy 30th, Ria" on it in blue icing.' },
  { customer: 'Rohan Mehta', channel: 'instagram', order: 'Rohan Mehta', hoursAgo: 9, read: true, text: 'Can you add one more hamper to my order? Same delivery day please.' },
  { customer: 'Meera Iyer', channel: 'whatsapp', order: 'Meera Iyer', hoursAgo: 5, read: true, text: 'Could the 50 wedding favour boxes be ready by tomorrow evening? It is for the sangeet.' },
  { customer: 'Kabir Singh', channel: 'instagram', order: 'Kabir Singh', hoursAgo: 3, read: true, text: 'I would love a cupcake tower for Saturday. Not sure about flavours yet, what do you suggest?' },
  { customer: 'Tara Bose', channel: 'instagram', order: 'Tara Bose', hoursAgo: 1.5, read: true, text: 'The brownies were a hit at the party, thank you so much!' },
  { customer: 'Nikhil Rao', channel: 'whatsapp', order: null, hoursAgo: 0.3, read: false, text: 'Hi! Any chance of 30 cake pops by tomorrow noon? Happy to pay extra for a rush.' },
];
