// DEMO DATA ONLY — not from a backend. Dates are relative to "now" so the demo always looks current.
const HOUR = 60 * 60 * 1000;
const at = (hours) => new Date(Date.now() + hours * HOUR).toISOString();
const created = (hoursAgo) => at(-hoursAgo);

// The offline demo uses the SAME five-order bakery story as the server seed (server/scripts/demo-data.js), so the board, plan and
// insights read identically with or without a backend.
import { buildDemoOrders, DEMO_MESSAGES } from '../../../server/scripts/demo-data.js';

export const demoSettings = () => ({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, workingDays: [1, 2, 3, 4, 5, 6], workStart: '09:00', workEnd: '18:00', dailyCapacityMinutes: 360, riskBufferMinutes: 240, customisationMinutes: 30, prepRules: [] });

const iso = (d) => new Date(d).toISOString();
export const seedOrders = () => buildDemoOrders(demoSettings(), new Date()).map((o, i) => ({
  quantity: 1, customisation: null, ...o, id: `ord_${1001 + i}`, deadline: iso(o.deadline), createdAt: iso(o.createdAt), updatedAt: iso(o.createdAt),
}));

// Sample inbox for demo mode: 6 messages, 5 read + 1 unread (the same messages as the server seed).
export const seedConversations = () => DEMO_MESSAGES.map((m, i) => {
  const order = seedOrders().find((o) => o.customerName === m.order);
  return { id: `conv_${i + 1}`, channel: m.channel, customerName: m.customer, orderId: order?.id ?? null, isDemo: true, unread: m.read ? 0 : 1, messages: [{ id: `m${i + 1}`, from: 'customer', text: m.text, at: at(-m.hoursAgo), read: m.read }] };
});

export const seedIntegrations = () => [
  { channel: 'whatsapp', status: 'demo', statusReason: 'Demo mode: sample data only. No WhatsApp account is linked.', accountLabel: null, lastSyncAt: null },
  { channel: 'instagram', status: 'unavailable', statusReason: 'Meta app permissions are not configured for this environment.', accountLabel: null, lastSyncAt: null },
];
