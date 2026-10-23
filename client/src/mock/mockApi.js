// In-memory DEMO backend that imitates docs/api-contract.md. Used only when VITE_DEMO_MODE is not 'false'.
// State resets on page reload. Nothing here talks to a real server.
import { ApiError } from '../services/api.js';
import { validateOrder } from '../utils/validateOrder.js';
import { seedOrders, seedConversations, seedIntegrations } from './data.js';
import { annotateRisk, buildDashboard, buildPlanner } from './engine.js';

let orders = seedOrders();
const conversations = seedConversations();
const integrations = seedIntegrations();

const wait = (ms = 350) => new Promise((r) => setTimeout(r, ms));
const clone = (x) => JSON.parse(JSON.stringify(x));
const withRisk = () => annotateRisk(orders);
const notFound = (id) => new ApiError(404, 'NOT_FOUND', `Order '${id}' not found.`);
const invalid = (details) => new ApiError(422, 'VALIDATION_ERROR', 'Request validation failed.', details);

const CREATABLE = ['customerName', 'source', 'item', 'quantity', 'prepTimeMinutes', 'deadline', 'status', 'paymentStatus'];
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

function simulate(body) {
  const changes = body.changes;
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 20) {
    throw invalid([{ field: 'changes', message: 'Provide between 1 and 20 changes.' }]);
  }
  let hypo = clone(orders);
  changes.forEach((c, i) => {
    if (c.type === 'add_order') {
      const details = validateOrder(c.order || {});
      if (details.length) throw invalid(details.map((d) => ({ ...d, field: `changes[${i}].order.${d.field}` })));
      hypo.push({ id: `change_${i}`, source: 'manual', quantity: 1, prepTimeMinutes: null, deadline: null, status: 'pending', paymentStatus: 'unverified', ...c.order });
    } else if (c.type === 'update_order' || c.type === 'cancel_order') {
      const idx = hypo.findIndex((o) => o.id === c.orderId);
      if (idx < 0) throw notFound(c.orderId);
      hypo[idx] = c.type === 'cancel_order' ? { ...hypo[idx], status: 'cancelled' } : { ...hypo[idx], ...(c.order || {}) };
    } else throw invalid([{ field: `changes[${i}].type`, message: 'Must be add_order, update_order or cancel_order.' }]);
  });

  const range = { from: undefined, days: Math.min(Number(body.days) || 7, 30) };
  const before = buildPlanner(orders, new Date(), range.days);
  const after = buildPlanner(hypo, new Date(), range.days);
  const beforeRisk = Object.fromEntries(before.risks.map((r) => [r.orderId, r]));
  const afterRisk = Object.fromEntries(after.risks.map((r) => [r.orderId, r]));
  return {
    simulated: true,
    planner: after,
    comparison: {
      pendingMinutesDelta: after.workload.pendingMinutes - before.workload.pendingMinutes,
      currentWorkload: before.workload,
      simulatedWorkload: after.workload,
      suggestedAdjustments: [],
      newRisks: after.risks.filter((r) => !beforeRisk[r.orderId] || (beforeRisk[r.orderId].risk === 'medium' && r.risk === 'high')),
      resolvedRisks: before.risks.filter((r) => !afterRisk[r.orderId]).map((r) => ({ orderId: r.orderId })),
    },
  };
}

export async function handleMockRequest(method, path, body = {}) {
  await wait();
  const url = new URL(path, 'http://mock.local');
  const p = url.pathname;
  const q = url.searchParams;
  let m;

  if (method === 'GET' && p === '/dashboard') return buildDashboard(orders);

  if (method === 'GET' && p === '/analytics/monthly') {
    // Same pure function the real server uses, so demo and live numbers are produced by one implementation.
    const { buildMonthly, isMonth, DATASETS } = await import('../../../server/services/analyticsService.js');
    const settings = { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, workingDays: [1, 2, 3, 4, 5, 6], workStart: '09:00', workEnd: '18:00', dailyCapacityMinutes: 360, riskBufferMinutes: 240, customisationMinutes: 30, prepRules: [] };
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
      ...body, id: `ord_${1000 + orders.length + 1 + Math.floor(Math.random() * 900)}`, createdAt: now, updatedAt: now,
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
      const details = [...rejectUnknown(body, CREATABLE), ...validateOrder(body, { partial: true })];
      if (details.length) throw invalid(details);
      if (['completed', 'cancelled'].includes(orders[idx].status) && body.status && body.status !== orders[idx].status) {
        throw new ApiError(409, 'CONFLICT', `Cannot change a ${orders[idx].status} order to '${body.status}'.`);
      }
      orders[idx] = { ...orders[idx], ...body, updatedAt: new Date().toISOString() };
      return clone(withRisk()[idx]);
    }
  }

  if (method === 'POST' && p === '/ai/extract-order') return extract(body);

  if (method === 'GET' && p === '/planner') {
    const days = Number(q.get('days') || 7);
    if (!Number.isInteger(days) || days < 1 || days > 30) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query.', [{ field: 'days', message: 'Must be between 1 and 30.' }]);
    return buildPlanner(orders, new Date(), days);
  }
  if (method === 'POST' && p === '/planner/simulate') return simulate(body);

  if (method === 'GET' && p === '/integrations') return { items: clone(integrations) };
  if (method === 'POST' && (m = p.match(/^\/integrations\/(whatsapp|instagram)\/connect$/))) {
    throw new ApiError(503, 'INTEGRATION_UNAVAILABLE', `${m[1] === 'whatsapp' ? 'WhatsApp' : 'Instagram'} connection is not available in demo mode. A Meta integration must be implemented on the backend first.`);
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
