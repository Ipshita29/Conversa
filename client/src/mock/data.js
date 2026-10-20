// DEMO DATA ONLY — not from a backend. Dates are relative to "now" so the demo always looks current.
const HOUR = 60 * 60 * 1000;
const at = (hours) => new Date(Date.now() + hours * HOUR).toISOString();
const created = (hoursAgo) => at(-hoursAgo);

const o = (n, f) => ({
  id: `ord_${1000 + n}`, source: 'manual', quantity: 1, prepTimeMinutes: null, deadline: null,
  status: 'pending', paymentStatus: 'unverified', createdAt: created(72 - n * 4), updatedAt: created(24 - n), ...f,
});

export const seedOrders = () => [
  o(1, { customerName: 'Aanya Sharma', source: 'whatsapp', item: 'Custom birthday cake (2 kg)', prepTimeMinutes: 240, deadline: at(5), status: 'in_progress', paymentStatus: 'verified' }),
  o(2, { customerName: 'Rohan Mehta', source: 'instagram', item: 'Gift hamper', quantity: 3, prepTimeMinutes: 240, deadline: at(20), status: 'confirmed', paymentStatus: 'pending' }),
  o(3, { customerName: 'Priya Nair', source: 'whatsapp', item: 'Cupcake box', quantity: 24, prepTimeMinutes: 120, deadline: at(27) }),
  o(4, { customerName: 'Kabir Singh', source: 'instagram', item: 'Custom portrait (A3)', prepTimeMinutes: 300, deadline: at(40), status: 'confirmed', paymentStatus: 'verified' }),
  o(5, { customerName: 'Meera Iyer', source: 'whatsapp', item: 'Wedding favours', quantity: 50, prepTimeMinutes: 300, deadline: at(76), paymentStatus: 'pending' }),
  o(6, { customerName: 'Sara Khan', item: 'Brownie tray', prepTimeMinutes: 90, deadline: at(100), status: 'confirmed', paymentStatus: 'verified' }),
  o(7, { customerName: 'Dev Patel', source: 'instagram', item: 'Cookie jars', quantity: 6, deadline: at(60) }),
  o(8, { customerName: 'Nisha Rao', source: 'whatsapp', item: 'Anniversary cake', prepTimeMinutes: 300 }),
  o(9, { customerName: 'Ishaan Verma', source: 'whatsapp', item: 'Cake pops', quantity: 30, prepTimeMinutes: 120, deadline: at(21), status: 'in_progress', paymentStatus: 'verified' }),
  o(10, { customerName: 'Tara Bose', item: 'Sketch commission', prepTimeMinutes: 240, deadline: at(-30), status: 'completed', paymentStatus: 'verified' }),
  o(11, { customerName: "Leo D'Souza", source: 'instagram', item: 'Macaron box', quantity: 2, prepTimeMinutes: 120, deadline: at(-50), status: 'completed', paymentStatus: 'verified' }),
  o(12, { customerName: 'Farah Ali', source: 'whatsapp', item: 'Birthday hamper', prepTimeMinutes: 90, deadline: at(10), status: 'cancelled', paymentStatus: 'rejected' }),
];

// Sample inbox for demo mode: 6 messages, 5 read + 1 unread (mirrors server/scripts/seed-demo.js).
const conv = (n, channel, customerName, orderId, hoursAgo, text, read = true) => ({
  id: `conv_${n}`, channel, customerName, orderId, isDemo: true, unread: read ? 0 : 1,
  messages: [{ id: `m${n}`, from: 'customer', text, at: at(-hoursAgo), read }],
});
export const seedConversations = () => [
  conv(1, 'whatsapp', 'Aanya Sharma', 'ord_1001', 26, 'Hi! Just checking the birthday cake is still on for tomorrow. Could you write "Happy 30th Meera" on it?'),
  conv(2, 'instagram', 'Rohan Mehta', 'ord_1002', 9, 'Can you add one more hamper to my order? Same delivery day please.'),
  conv(3, 'whatsapp', 'Priya Nair', 'ord_1003', 5, "Thanks for confirming! I'll send the payment screenshot this evening."),
  conv(4, 'instagram', 'Kabir Singh', 'ord_1004', 3, 'How long will the portrait take? I would love to gift it next Saturday.'),
  conv(5, 'instagram', 'Tara Bose', 'ord_1010', 1.5, 'Received the sketch. It is beautiful, thank you so much!'),
  conv(6, 'whatsapp', 'Nikhil Rao', null, 0.3, 'Hi! Any chance of 30 cake pops by tomorrow noon? Happy to pay extra for a rush.', false),
];

export const seedIntegrations = () => [
  { channel: 'whatsapp', status: 'demo', statusReason: 'Demo mode: sample data only. No WhatsApp account is linked.', accountLabel: null, lastSyncAt: null },
  { channel: 'instagram', status: 'unavailable', statusReason: 'Meta app permissions are not configured for this environment.', accountLabel: null, lastSyncAt: null },
];
