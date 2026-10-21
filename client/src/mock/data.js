// DEMO DATA ONLY — not from a backend. Dates are relative to "now" so the demo always looks current.
const HOUR = 60 * 60 * 1000;
const at = (hours) => new Date(Date.now() + hours * HOUR).toISOString();
const created = (hoursAgo) => at(-hoursAgo);

const o = (n, f) => ({
  id: `ord_${1000 + n}`, source: 'manual', quantity: 1, customisation: null, prepTimeMinutes: null, deadline: null,
  status: 'pending', paymentStatus: 'unverified', createdAt: created(72 - n * 4), updatedAt: created(24 - n), ...f,
});

// The same five-order home-bakery story as server/scripts/demo-data.js (the real seed places its deadlines from the
// scheduler's own finish times; this offline mock can only approximate that with fixed offsets).
export const seedOrders = () => [
  o(1, { customerName: 'Aanya Sharma', source: 'whatsapp', item: 'Birthday cake (2 kg)', customisation: 'Name and age in blue icing', prepTimeMinutes: 240, deadline: at(20), status: 'in_progress', paymentStatus: 'verified', notes: '[DEMO] already started, finishes comfortably early' }),
  o(2, { customerName: 'Rohan Mehta', source: 'instagram', item: 'Festive gift hampers', quantity: 3, prepTimeMinutes: 300, deadline: at(27), status: 'confirmed', paymentStatus: 'pending', notes: '[DEMO] fits, but with a thin buffer' }),
  o(3, { customerName: 'Meera Iyer', source: 'whatsapp', item: 'Wedding favour boxes', quantity: 50, customisation: 'Gold ribbon, names on tags', prepTimeMinutes: 300, deadline: at(29), notes: '[DEMO] customer asked for a date the queue cannot meet' }),
  o(4, { customerName: 'Kabir Singh', source: 'instagram', item: 'Custom cupcake tower', customisation: 'Flavours and theme still to be confirmed', deadline: at(96), notes: '[DEMO] cannot be scheduled until the details are confirmed' }),
  o(5, { customerName: 'Tara Bose', item: 'Brownie tray', quantity: 2, prepTimeMinutes: 90, deadline: at(-20), status: 'completed', paymentStatus: 'verified', notes: '[DEMO] delivered and paid' }),
];

// Sample inbox for demo mode: 6 messages, 5 read + 1 unread (mirrors server/scripts/demo-data.js).
const conv = (n, channel, customerName, orderId, hoursAgo, text, read = true) => ({
  id: `conv_${n}`, channel, customerName, orderId, isDemo: true, unread: read ? 0 : 1,
  messages: [{ id: `m${n}`, from: 'customer', text, at: at(-hoursAgo), read }],
});
export const seedConversations = () => [
  conv(1, 'whatsapp', 'Aanya Sharma', 'ord_1001', 26, 'Hi! Is the cake still on track? Please write "Happy 30th, Ria" on it in blue icing.'),
  conv(2, 'instagram', 'Rohan Mehta', 'ord_1002', 9, 'Can you add one more hamper to my order? Same delivery day please.'),
  conv(3, 'whatsapp', 'Meera Iyer', 'ord_1003', 5, 'Could the 50 wedding favour boxes be ready by tomorrow evening? It is for the sangeet.'),
  conv(4, 'instagram', 'Kabir Singh', 'ord_1004', 3, 'I would love a cupcake tower for Saturday. Not sure about flavours yet, what do you suggest?'),
  conv(5, 'instagram', 'Tara Bose', 'ord_1005', 1.5, 'The brownies were a hit at the party, thank you so much!'),
  conv(6, 'whatsapp', 'Nikhil Rao', null, 0.3, 'Hi! Any chance of 30 cake pops by tomorrow noon? Happy to pay extra for a rush.', false),
];

export const seedIntegrations = () => [
  { channel: 'whatsapp', status: 'demo', statusReason: 'Demo mode: sample data only. No WhatsApp account is linked.', accountLabel: null, lastSyncAt: null },
  { channel: 'instagram', status: 'unavailable', statusReason: 'Meta app permissions are not configured for this environment.', accountLabel: null, lastSyncAt: null },
];
