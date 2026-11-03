// DEMO DATA ONLY — not from a backend. Dates are relative to "now" so the demo always looks current.
const HOUR = 60 * 60 * 1000;
const at = (hours) => new Date(Date.now() + hours * HOUR).toISOString();
const created = (hoursAgo) => at(-hoursAgo);

// The offline demo uses the SAME five-order bakery story as the server seed (server/scripts/demo-data.js), so the board, plan and
// insights read identically with or without a backend.
import { buildAllDemoOrders, DEMO_CONVERSATIONS } from '../../../server/scripts/demo-data.js';

// The demo pictures are local files (server/assets/demo), bundled with the app: nothing is fetched from the internet.
const PICTURES = Object.fromEntries(Object.entries(import.meta.glob('../../../server/assets/demo/*.png', { eager: true, query: '?url', import: 'default' })).map(([k, v]) => [k.split('/').pop(), v]));

export const demoSettings = () => ({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, workingDays: [1, 2, 3, 4, 5, 6], workStart: '09:00', workEnd: '18:00', dailyCapacityMinutes: 360, riskBufferMinutes: 240, customisationMinutes: 30, prepRules: [] });

const iso = (d) => new Date(d).toISOString();
export const seedOrders = () => buildAllDemoOrders(demoSettings(), new Date()).map((o, i) => ({
  quantity: 1, customisation: null, ...o, id: `ord_${1001 + i}`, deadline: iso(o.deadline), createdAt: iso(o.createdAt), updatedAt: iso(o.createdAt),
}));

// What the API must not show but the demo needs: for each picture message, which file it is and the preset reading of a payment screenshot.
export const demoMessageMeta = new Map();

// Sample conversations for demo mode: the same five conversations as the server seed (server/scripts/demo-data.js). Payment screenshots start
// as "processing"; mockPayments.js runs them through the same detection rules as the server and fills in the outcome.
export const seedConversations = () => DEMO_CONVERSATIONS.map((c, i) => {
  const order = seedOrders().find((o) => o.customerName === c.order);
  const id = `conv_${i + 1}`;
  const messages = c.messages.map((m, j) => {
    const mid = `m${i + 1}_${j + 1}`;
    if (m.image) demoMessageMeta.set(mid, { file: m.image.file, reading: m.image.reading ?? null });
    if (m.image?.ownerConfirmed) demoMessageMeta.set(mid, { ...demoMessageMeta.get(mid), ownerConfirmed: true });
    return {
      id: mid, from: m.from ?? 'customer', text: m.text, at: at(-m.hoursAgo), read: !m.unread,
      attachment: m.image ? { url: PICTURES[m.image.file], contentType: 'image/png' } : null,
      scan: m.image ? (m.image.kind === 'payment' ? { state: 'processing', reason: null } : { state: 'not_payment', reason: 'Demo reference picture.' }) : null,
      payment: null,
    };
  });
  return { id, channel: c.channel, customerName: c.customer, orderId: order?.id ?? null, isDemo: true, unread: messages.filter((m) => !m.read && m.from === 'customer').length, messages };
});

export const seedIntegrations = () => [
  { channel: 'whatsapp', status: 'demo', statusReason: 'Demo mode: sample data only. No WhatsApp account is linked.', accountLabel: null, lastSyncAt: null },
  { channel: 'instagram', status: 'unavailable', statusReason: 'Meta app permissions are not configured for this environment.', accountLabel: null, lastSyncAt: null },
];
