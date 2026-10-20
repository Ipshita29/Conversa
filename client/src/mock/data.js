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

// Sample conversations for the Inbox. NOT part of docs/api-contract.md (no conversations endpoint yet).
export const seedConversations = () => [
  {
    id: 'conv_1', channel: 'whatsapp', customerName: 'Priya Nair', phone: '+91 98•••• 1204', unread: 0, orderId: 'ord_1003',
    messages: [
      { id: 'm1', from: 'customer', text: 'Hi! Can I get 24 cupcakes by Friday evening? Chocolate please.', at: at(-26) },
      { id: 'm2', from: 'seller', text: 'Sure! I will confirm the price shortly.', at: at(-25) },
    ],
  },
  {
    id: 'conv_2', channel: 'instagram', customerName: 'Aditi Rao', handle: '@aditi.makes', unread: 2, orderId: null,
    messages: [
      { id: 'm3', from: 'customer', text: 'Love your work! Do you do custom portraits? I need 2 portraits for my parents anniversary next Saturday.', at: at(-3) },
      { id: 'm4', from: 'customer', text: 'Budget is flexible, A3 size would be nice.', at: at(-2) },
    ],
  },
  {
    id: 'conv_3', channel: 'whatsapp', customerName: 'Rohan Mehta', phone: '+91 99•••• 8841', unread: 1, orderId: 'ord_1002',
    messages: [
      { id: 'm5', from: 'customer', text: 'Can you also add 1 more gift hamper to my order? Same delivery day.', at: at(-1) },
    ],
  },
  {
    id: 'conv_4', channel: 'whatsapp', customerName: 'Unknown (+91 90•••• 5567)', phone: '+91 90•••• 5567', unread: 1, orderId: null,
    messages: [
      { id: 'm6', from: 'customer', text: 'Hello, need a 1 kg birthday cake tomorrow morning. Is it possible?', at: at(-0.5) },
    ],
  },
];

export const seedIntegrations = () => [
  { channel: 'whatsapp', status: 'demo', statusReason: 'Demo mode: sample data only. No WhatsApp account is linked.', accountLabel: null, lastSyncAt: null },
  { channel: 'instagram', status: 'unavailable', statusReason: 'Meta app permissions are not configured for this environment.', accountLabel: null, lastSyncAt: null },
];
