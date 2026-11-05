// In-memory DEMO backend that imitates docs/api-contract.md. Used only when VITE_DEMO_MODE is not 'false'.
// State resets on page reload. Nothing here talks to a real server.
import { ApiError } from '../services/api.js';
import { validateOrder } from '../utils/validateOrder.js';
import { seedOrders, seedConversations, seedIntegrations, demoSettings as baseSettings } from './data.js';
// The offline demo runs the SAME scheduler as the server, in the browser, so every page agrees with every other page.
import { computePlan, publicPlan, suggestScenario } from '../../../server/services/workloadEngine.js';
import { createMockPayments } from './mockPayments.js';
import { scopeOrders, scopeNow, overview, runMove } from '../../../server/services/whatIf.js';
import { extractOrderSpec, imageKind } from '../../../server/services/orderSpec.js';
import { orderSummary, replyContext, ruleSuggestions, shortId } from '../../../server/services/replyLogic.js';
import { buildDashboard as serverDashboard } from '../../../server/services/dashboardService.js';

let orders = seedOrders();
const demoSettings = () => baseSettings();
const conversations = seedConversations();
const payments = createMockPayments(() => orders, () => conversations);
const integrations = seedIntegrations();

const wait = (ms = 350) => new Promise((r) => setTimeout(r, ms));
const clone = (x) => JSON.parse(JSON.stringify(x));
const withRisk = () => {
  const plan = computePlan({ orders, settings: demoSettings(), now: new Date(), rangeDays: 1 });
  return orders.map((o) => ({ ...o, risk: plan.results[o.id]?.risk ?? null }));
};
const notFound = (id) => new ApiError(404, 'NOT_FOUND', `Order '${id}' not found.`);
const invalid = (details) => new ApiError(422, 'VALIDATION_ERROR', 'Request validation failed.', details);

const PATCHABLE = ['customerName', 'source', 'item', 'quantity', 'price', 'prepTimeMinutes', 'deadline', 'status', 'paymentStatus'];
const CREATABLE = [...PATCHABLE, 'createdAt']; // the placed date/time can be set once, on create
function rejectUnknown(body, allowed) {
  return Object.keys(body).filter((k) => !allowed.includes(k)).map((k) => ({ field: k, message: 'Unknown or read-only field.' }));
}

function extract(body) {
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const details = [];
  if (!message) details.push({ field: 'message', message: 'Message is required.' });
  if (message.length > 4000) details.push({ field: 'message', message: 'Message must be at most 4000 characters.' });
  if (!['manual', 'whatsapp', 'instagram'].includes(body.source)) details.push({ field: 'source', message: 'Must be manual, whatsapp or instagram.' });
  if (details.length) throw invalid(details);

  const ref = body.referenceTime ? new Date(body.referenceTime) : new Date();
  const lower = message.toLowerCase();
  const uncertainties = [];

  // Naive keyword heuristics standing in for the real AI service.
  const items = ['birthday cake', 'anniversary cake', 'cake', 'cupcakes', 'cookies', 'brownies', 'macarons', 'hamper', 'portraits', 'portrait', 'painting', 'sketch', 'favours'];
  const found = [...items].sort((a, b) => b.length - a.length).find((k) => lower.includes(k)); // longest match first ("cupcakes" before "cake")
  let quantity = null;
  const dozen = lower.match(/(\d+|a|one|two|three)\s*dozen/);
  const num = lower.match(/\b(\d+)\b/);
  const words = { a: 1, one: 1, two: 2, three: 3 };
  if (dozen) {
    quantity = (words[dozen[1]] ?? Number(dozen[1])) * 12;
    uncertainties.push({ field: 'quantity', message: `"${dozen[0]}" interpreted as ${quantity} units; confirm.` });
  } else if (num) {
    quantity = Number(num[1]);
    if (/kg|cm|inch|a\d/.test(lower.slice(num.index, num.index + num[1].length + 4))) {
      uncertainties.push({ field: 'quantity', message: `"${num[0]}" might be a size/weight, not a count; confirm.` });
    }
  } else if (/\b(a|an|one)\b/.test(lower) && found) {
    quantity = 1;
    uncertainties.push({ field: 'quantity', message: 'Quantity not stated; assumed 1.' });
  }

  let deadline = null;
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const target = new Date(ref);
  const dayHit = days.findIndex((d) => lower.includes(d));
  if (lower.includes('tomorrow')) { target.setDate(target.getDate() + 1); deadline = target; }
  else if (lower.includes('today')) deadline = target;
  else if (dayHit >= 0) { target.setDate(target.getDate() + ((dayHit - target.getDay() + 7) % 7 || 7)); deadline = target; }
  if (deadline) {
    const hour = /morning/.test(lower) ? 10 : /noon/.test(lower) ? 12 : /evening|night/.test(lower) ? 18 : 17;
    deadline.setHours(hour, 0, 0, 0);
    uncertainties.push({ field: 'deadline', message: `Interpreted as ${deadline.toLocaleString()}; confirm the exact day and time.` });
  }

  const sign = message.match(/[-–—]\s*([A-Z][a-z]+)\s*$/);
  const customerName = body.customerName || (sign ? sign[1] : null);

  const draft = {
    customerName, source: body.source, item: found ? found[0].toUpperCase() + found.slice(1) : null,
    quantity, prepTimeMinutes: null, deadline: deadline ? deadline.toISOString() : null,
  };
  const missingFields = Object.keys(draft).filter((k) => draft[k] === null);
  return { draft, missingFields, uncertainties, isDraft: true };
}


// The what-if runs on the same scheduler the real server uses, so the demo explains itself exactly like the live app.
async function simulateWithRealEngine(body) {
  const { simulate: run } = await import('../../../server/services/workloadEngine.js');
  const days = Math.min(Number(body.days) || 7, 30);
  return clone(run({ orders, changes: body.changes, settings: demoSettings(), now: new Date(), rangeDays: days, probeMinutes: body.probeMinutes ?? 60 }));
}

export async function handleMockRequest(method, path, body = {}) {
  await wait();
  const url = new URL(path, 'http://mock.local');
  const p = url.pathname;
  const q = url.searchParams;
  let m;

  if (method === 'GET' && p === '/dashboard') return clone(serverDashboard(orders, demoSettings()));

  if (method === 'GET' && p === '/board') {
    const { buildBoard } = await import('../../../server/services/boardService.js');
    const dataset = q.get('dataset') || 'all';
    return clone(buildBoard({ orders, settings: demoSettings(), now: new Date(), dataset }));
  }

  if (method === 'GET' && p === '/analytics/summary') {
    const { buildSummary, checkCustomRange, RANGES } = await import('../../../server/services/insightsService.js');
    const { zonedParts } = await import('../../../server/utils/timezone.js');
    const settings = demoSettings(); const now = new Date();
    const dataset = q.get('dataset') || 'all';
    if (!['all', 'real', 'demo'].includes(dataset)) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query.', [{ field: 'dataset', message: 'Must be real, demo or all.' }]);
    const from = q.get('from'); const to = q.get('to');
    if (from !== null || to !== null) {
      const { details } = checkCustomRange(from, to, zonedParts(now, settings.timezone));
      if (details.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query.', details);
      return clone(buildSummary({ orders, settings, from, to, now, dataset }));
    }
    const days = q.get('range') === null ? 7 : Number(q.get('range'));
    if (!RANGES.includes(days)) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query.', [{ field: 'range', message: `Must be one of ${RANGES.join(', ')}.` }]);
    return clone(buildSummary({ orders, settings, days, now, dataset }));
  }

  if (method === 'GET' && p === '/analytics/monthly') {
    // Same pure function the real server uses, so demo and live numbers are produced by one implementation.
    const { buildMonthly, isMonth, DATASETS } = await import('../../../server/services/analyticsService.js');
    const settings = demoSettings();
    const now = new Date();
    const month = q.get('month') || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    if (!isMonth(month)) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query.', [{ field: 'month', message: 'Must be a month in YYYY-MM format.' }]);
    const dataset = q.get('dataset') || 'all';
    if (!DATASETS.includes(dataset)) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query.', [{ field: 'dataset', message: 'Must be real, demo or all.' }]);
    return clone(buildMonthly({ orders, settings, month, now, dataset }));
  }

  if (method === 'GET' && p === '/orders') {
    let items = withRisk();
    if (q.get('status')) items = items.filter((o) => q.get('status').split(',').includes(o.status));
    if (q.get('paymentStatus')) items = items.filter((o) => o.paymentStatus === q.get('paymentStatus'));
    if (q.get('source')) items = items.filter((o) => o.source === q.get('source'));
    const sort = q.get('sort') || 'deadline';
    const dir = sort.startsWith('-') ? -1 : 1;
    const key = sort.replace('-', '');
    items.sort((a, b) => {
      if (key === 'deadline') { if (!a.deadline) return 1; if (!b.deadline) return -1; }
      return dir * (new Date(a[key]) - new Date(b[key]));
    });
    const pageSize = Math.min(Number(q.get('pageSize')) || 20, 100);
    const page = Number(q.get('page')) || 1;
    return clone({ items: items.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: items.length });
  }

  if (method === 'POST' && p === '/orders') {
    const details = [...rejectUnknown(body, CREATABLE), ...validateOrder(body)];
    if (details.length) throw invalid(details);
    const now = new Date().toISOString();
    const order = {
      source: 'manual', quantity: 1, prepTimeMinutes: null, deadline: null, status: 'pending', paymentStatus: 'unverified',
      ...body, id: `ord_${1000 + orders.length + 1 + Math.floor(Math.random() * 900)}`, createdAt: body.createdAt ?? now, updatedAt: now,
    };
    orders.push(order);
    return clone(withRisk().find((o) => o.id === order.id));
  }

  if ((m = p.match(/^\/orders\/([^/]+)$/))) {
    const id = decodeURIComponent(m[1]);
    const idx = orders.findIndex((o) => o.id === id);
    if (idx < 0) throw notFound(id);
    if (method === 'GET') return clone(withRisk()[idx]);
    if (method === 'PATCH') {
      const details = [...rejectUnknown(body, PATCHABLE), ...validateOrder(body, { partial: true })];
      if (details.length) throw invalid(details);
      if (['completed', 'cancelled'].includes(orders[idx].status) && body.status && body.status !== orders[idx].status) {
        throw new ApiError(409, 'CONFLICT', `Cannot change a ${orders[idx].status} order to '${body.status}'.`);
      }
      const completing = body.status === 'completed' && orders[idx].status !== 'completed';
      orders[idx] = { ...orders[idx], ...body, ...(completing ? { completedAt: new Date().toISOString() } : {}), updatedAt: new Date().toISOString() }; // like the server: completion time is recorded by the system
      return clone(withRisk()[idx]);
    }
  }

  if (p === '/payments' || p.startsWith('/payments/') || /^\/conversations\/[^/]+\/(attachments|messages\/[^/]+\/extract-payment)$/.test(p)) return clone(await payments(method, p, body));
  if (method === 'POST' && p === '/ai/extract-order') return extract(body);

  if (method === 'GET' && p === '/planner') {
    const days = Number(q.get('days') || 7);
    if (!Number.isInteger(days) || days < 1 || days > 30) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query.', [{ field: 'days', message: 'Must be between 1 and 30.' }]);
    const now = new Date();
    return clone({ ...publicPlan(computePlan({ orders, settings: demoSettings(), now, rangeDays: days })), suggestedScenario: suggestScenario({ orders, settings: demoSettings(), now, rangeDays: days }) });
  }
  if (p === '/planner/whatif' || p === '/planner/whatif/move') { // the What-if page: the same engine module as the server, on the loaded orders, read-only
    const asked = method === 'GET' ? q.get('scope') : body?.scope; const scope = asked === 'all' || asked === 'commitment' ? asked : 'demo';
    const input = { orders: scopeOrders(clone(orders), scope), settings: demoSettings(), now: scopeNow(scope, demoSettings(), new Date()) };
    if (p === '/planner/whatif') return clone(overview(input));
    return clone(runMove({ ...input, orderId: body?.orderId, deadline: body?.deadline }));
  }
  if (method === 'POST' && p === '/planner/simulate') return simulateWithRealEngine(body);

  if (method === 'GET' && (m = p.match(/^\/orders\/([^/]+)\/conversation$/))) { // the order's conversation and the specification read from it (same rules as the server)
    const id = decodeURIComponent(m[1]);
    if (!orders.some((o) => o.id === id)) throw notFound(id);
    const conv = conversations.find((c) => c.orderId === id);
    const messages = (conv?.messages ?? []).map((x) => ({ ...x, kind: imageKind(x) }));
    return clone({ conversation: conv ? { id: conv.id, channel: conv.channel, customerName: conv.customerName, isDemo: Boolean(conv.isDemo) } : null, messages, spec: extractOrderSpec(messages) });
  }

  if (method === 'GET' && p === '/integrations') return { items: clone(integrations) };
  if (method === 'POST' && (m = p.match(/^\/integrations\/(whatsapp|instagram)\/connect$/))) {
    throw new ApiError(503, 'INTEGRATION_UNAVAILABLE', `${m[1] === 'whatsapp' ? 'WhatsApp' : 'Instagram'} connection is not available in demo mode. A Meta integration must be implemented on the backend first.`);
  }


  // Reply tools (demo): the same pure logic as the server, on the browser's own conversations and payment ledger. Sends are SIMULATED:
  // the message is added to the demo chat and nothing leaves the browser.
  if ((m = p.match(/^\/conversations\/([^/]+)\/(suggestions|order-summary|messages)$/))) {
    const conv = conversations.find((x) => x.id === m[1]);
    if (!conv) throw new ApiError(404, 'NOT_FOUND', `Conversation '${m[1]}' not found.`);
    if (m[2] === 'messages' && method === 'POST') {
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!text) throw invalid([{ field: 'text', message: 'Write a message first.' }]);
      if (text.length > 1000) throw invalid([{ field: 'text', message: 'Keep it under 1000 characters.' }]);
      if (body?.simulateFailure) throw new ApiError(502, 'SEND_FAILED', 'The message could not be sent (simulated failure).');
      const msg = { id: `out_${Date.now()}_${conv.messages.length}`, from: 'business', text, at: new Date().toISOString(), read: true, attachment: null, scan: null, payment: null, delivery: { mode: 'simulated', state: 'sent' } };
      conv.messages.push(msg);
      return clone(msg);
    }
    const asked = (method === 'GET' ? q.get('orderId') : body?.orderId) || null;
    const open = ['pending', 'confirmed', 'in_progress'];
    let candidates = conv.orderId ? orders.filter((o) => o.id === conv.orderId) : orders.filter((o) => open.includes(o.status) && o.customerName.trim().toLowerCase() === (conv.customerName ?? '').trim().toLowerCase());
    let order = null;
    if (asked) { order = orders.find((o) => o.id === asked); if (!order) throw notFound(asked); if (!candidates.some((o) => o.id === order.id)) candidates = [order, ...candidates]; }
    else if (candidates.length === 1) [order] = candidates;
    const cands = candidates.map((o) => ({ id: o.id, item: o.item, quantity: o.quantity, deadline: o.deadline ?? null, shortId: shortId(o.id) }));
    const row = order ? (await payments('GET', '/payments', null)).rows.find((r) => r.orderId === order.id) ?? null : null;
    const tz = demoSettings().timezone;
    if (m[2] === 'order-summary') {
      const messages = conv.messages.map((x) => ({ ...x, kind: imageKind(x) }));
      return clone({ summary: order ? orderSummary(order, row, { tz, spec: extractOrderSpec(messages), customerName: conv.customerName }) : null, candidates: cands, reason: order ? null : cands.length > 1 ? 'choose' : 'no_order' });
    }
    return clone({ context: replyContext({ customerName: conv.customerName, channel: conv.channel, messages: conv.messages, order, row, tz }), orderId: order?.id ?? null, candidates: cands });
  }

  if (method === 'GET' && p === '/conversations') return { items: clone(conversations) };
  if (method === 'PATCH' && (m = p.match(/^\/conversations\/([^/]+)$/))) {
    const c = conversations.find((x) => x.id === m[1]);
    if (!c) throw new ApiError(404, 'NOT_FOUND', `Conversation '${m[1]}' not found.`);
    if (body.read === true) { c.messages.forEach((x) => { x.read = true; }); c.unread = 0; }
    if ('orderId' in body) c.orderId = body.orderId;
    return clone(c);
  }

  throw new ApiError(404, 'NOT_FOUND', `Demo API has no route ${method} ${p}.`);
}
