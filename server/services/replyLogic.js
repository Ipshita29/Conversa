// Smart replies and the order summary, as pure functions (no database, no network). The server and the in-browser demo both use these,
// so a summary or a suggestion is worked out the same way in both. Nothing here invents a fact: every figure and date comes from the order
// record, its payment records or the customer's own messages; whatever is missing is left out, or turned into a question.
import { summarize, round2 } from './paymentLogic.js';

const METHOD = { upi: 'UPI', bank_transfer: 'Bank transfer', cash: 'Cash', cod: 'Cash on delivery', other: 'Other' };
// Customer-facing wording for the payment state (never says "paid" for money the owner has not confirmed).
const PAY_TEXT = { paid: 'Paid in full', partial: 'Partly paid', verification_pending: 'Payment received, being verified', cod: 'Cash on delivery', due: 'Unpaid' };

// What to ask the customer for, by missing order field (internal fields such as the preparation time are never asked of the customer).
const ASK_FOR = { item: 'which product you would like', quantity: 'how many you need (and the size)', deadline: 'the date and time you need it by' };
const askList = (fields) => { const t = fields.map((f) => ASK_FOR[f]); return t.length > 1 ? `${t.slice(0, -1).join(', ')} and ${t.at(-1)}` : t[0]; };

export const inr = (n) => `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: n % 1 ? 2 : 0 }).format(n)}`;
const when = (iso, tz, withTime = true) => (iso ? new Intl.DateTimeFormat('en-IN', { timeZone: tz || undefined, weekday: 'short', day: 'numeric', month: 'short', ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}) }).format(new Date(iso)) : null);
export const shortId = (id) => `#${/^[a-f\d]{24}$/i.test(String(id)) ? String(id).slice(-6).toUpperCase() : String(id).replace(/^ord_/, '')}`;
const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || null;

// ---- Order facts -----------------------------------------------------------------------------------------------------------
// `row` is the order's line in the payment ledger (summarize() output plus method); without one the figures are worked out from the order alone.
export function orderFacts(order, row, tz) {
  if (!order) return null;
  const s = row ?? { ...summarize(order, []), method: null, toVerify: 0 };
  const m = String(order.item ?? '').match(/^(.*?)\s*\(([^)]+)\)\s*$/); // "Chocolate cake (2 kg)": the bracket is the size
  return {
    id: order.id, shortId: shortId(order.id), product: (m ? m[1] : order.item) || null, size: m ? m[2] : null, item: order.item ?? null,
    quantity: order.quantity ?? null, customisation: order.customisation || null, status: order.status,
    orderedAt: order.createdAt ?? null, deadline: order.deadline ?? null, deadlineText: when(order.deadline, tz),
    total: s.total, paid: s.paid, balance: s.balance, pending: s.pending ?? 0, codDue: s.codDue ?? 0,
    isDraft: order.status === 'draft', missing: order.status === 'draft' ? (order.draft?.missingFields ?? []).filter((f) => ASK_FOR[f]) : [], // what an unconfirmed draft still lacks
    paymentState: s.status, paymentText: PAY_TEXT[s.status] ?? null, method: methodOf(s),
  };
}

// The method to quote: the one money was actually confirmed with; else the one a pending claim used; cash on delivery only when that is all there is.
function methodOf(s) {
  const recs = (s.payments ?? []).filter((p) => p.kind !== 'refund' && p.status !== 'rejected');
  const pick = recs.find((p) => p.status === 'confirmed') ?? recs.find((p) => p.status === 'pending' && p.method !== 'cod') ?? recs.find((p) => p.method === 'cod');
  return pick?.method ?? s.method ?? (s.codDue > 0 ? 'cod' : null);
}

// ---- Feature 2: the order summary ------------------------------------------------------------------------------------------
// Returns the lines that exist (label, value) and the finished text. Unavailable fields are left out, never filled in.
export function orderSummary(order, row, { tz, spec = null, customerName = null } = {}) {
  const f = orderFacts(order, row, tz);
  if (!f) return null;
  const said = (key) => spec?.fields?.find((x) => x.key === key)?.value ?? null; // what the customer wrote, e.g. the message on the cake
  const lines = [
    ['Order', f.shortId],
    ['Product', f.product],
    ['Quantity', f.quantity],
    ['Size', f.size],
    ['Flavour', said('flavour') && !String(f.customisation ?? '').toLowerCase().includes(said('flavour').toLowerCase()) ? said('flavour') : null],
    ['Customisation', f.customisation],
    ['Message on the cake', said('cakeMessage')],
    ['Icing colour', said('icingColour')],
    ['Total', f.total === null ? null : inr(f.total)],
    ['Paid', inr(f.paid)],
    ['Awaiting verification', f.pending > 0 ? inr(f.pending) : null],
    ['Balance', f.balance === null ? null : inr(f.balance)],
    ['Ordered on', when(f.orderedAt, tz, false)],
    ['Delivery', f.deadlineText],
    ['Payment method', f.method ? METHOD[f.method] ?? f.method : null],
    ['Payment status', f.paymentText],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');
  const hi = firstName(customerName ?? order.customerName);
  const text = [`Hi${hi ? ` ${hi}` : ''}, here is a summary of your order:`, '', ...lines.map(([k, v]) => `${k}: ${v}`), '', 'Please let me know if anything needs changing.'].join('\n');
  return { orderId: order.id, lines: lines.map(([label, value]) => ({ label, value: String(value) })), text };
}

// ---- Feature 1: smart replies ----------------------------------------------------------------------------------------------
// The context handed to a reply generator: the last few text messages and the facts of the linked order, nothing more.
export function replyContext({ customerName, channel, messages, order, row, tz }) {
  const recent = (messages ?? []).filter((m) => m.text).slice(-8).map((m) => ({ from: m.from === 'customer' ? 'customer' : 'business', text: String(m.text).slice(0, 400) }));
  return { customer: firstName(customerName), channel: channel ?? null, recent, order: orderFacts(order, row, tz) };
}

const has = (t, re) => re.test(t);
// Rule-based suggestions: the fallback when the AI is unavailable, and the demo's engine. Two or three short replies, each safe:
// they state only what is in the context, or ask the customer for what is missing.
export function ruleSuggestions(ctx) {
  const lastIn = [...ctx.recent].reverse().find((m) => m.from === 'customer');
  const t = (lastIn?.text ?? '').toLowerCase();
  const o = ctx.order; const hi = ctx.customer ? `Hi ${ctx.customer}! ` : '';
  const out = [];
  const add = (text) => { if (!out.includes(text)) out.push(text); };

  if (o?.isDraft && o.missing.length) add(`${hi}Thanks! To go ahead with your order, could you tell me ${askList(o.missing)}?`); // the draft is missing essentials: ask for exactly those
  if (!lastIn) add(`${hi}How can I help you today?`);
  if (lastIn && has(t, /\b(price|cost|how much|charge|rate|quote|₹|rs\.?)\b/)) {
    if (o?.total != null) add(`The total for your order is ${inr(o.total)}.`);
    else { add('Thanks for asking! Could you tell me the product, quantity and size, so I can confirm the price?'); }
  }
  if (lastIn && has(t, /\b(paid|payment|pay|upi|transfer|transaction|screenshot|advance|sent the money|gpay|phonepe|paytm)\b/)) {
    if (o?.paymentState === 'paid') add('Thank you! Your payment is confirmed.');
    else if (o?.paymentState === 'verification_pending') add('Thank you, I have your payment details. I will confirm once I have checked my account.');
    else if (o?.balance != null && o.balance > 0 && o.paid > 0) add(`Thank you! The remaining balance on your order is ${inr(o.balance)}.`);
    else add('Thank you! Could you share the payment screenshot or the transaction ID, so I can confirm it?');
  }
  if (lastIn && has(t, /\b(ready|when|time|deliver|delivery|pick ?up|status|update|late|where|by today|by tomorrow)\b/)) {
    if (o?.deadlineText && o.status === 'completed') add('Your order is complete. Let me know how you would like to receive it.');
    else if (o?.deadlineText) add(`Your order is scheduled for ${o.deadlineText}. I will let you know if anything changes.`);
    else if (o) add('Let me check the schedule and get back to you with the delivery time shortly.');
    else add('Which date and time do you need it by? I will check if I can make it.');
  }
  if (lastIn && has(t, /\b(cancel|change|modify|different|instead|update the order)\b/)) add('Sure! Tell me what you would like to change and I will check if it is possible.');
  if (lastIn && has(t, /\b(order|want|need|book|available|do you (make|take|have))\b/) && !o) {
    add('Could you share the product, quantity, and the date and time you need it by?');
  }
  if (lastIn && has(t, /\b(thanks|thank you|great|perfect|ok(ay)?|got it|noted)\b/) && out.length === 0) add("You're welcome! Let me know if you need anything else.");

  add(o ? `${hi}Thanks for your message! Let me check and get back to you shortly.` : `${hi}Thanks for your message! Could you share a few more details so I can help?`);
  if (o && out.length < 3) add('Is there anything else you would like me to check on your order?');
  return out.slice(0, 3).map((text, i) => ({ id: `s${i + 1}`, text }));
}

// ---- AI: prompt, and a guard that drops any reply stating a fact the context does not contain -----------------------------------
export const REPLY_SYSTEM = `You help a small-business owner reply to a customer on WhatsApp or Instagram. Write 2 or 3 short, warm, natural replies the owner could send as their next message.
Hard rules:
- Use ONLY facts given in the context. Never invent prices, delivery dates or times, stock or availability, or an order confirmation.
- If the customer asks something the context cannot answer, reply with a short, polite clarifying question or say you will check and get back to them.
- Never say an order is confirmed, ready or paid unless the context says so.
- Each reply is plain text, under 220 characters, with no placeholders, no quotation marks around it, and no emoji unless the customer used one.
Return JSON only: {"replies":["...","..."]}`;

export const replyPrompt = (ctx) => JSON.stringify({
  customerFirstName: ctx.customer, channel: ctx.channel,
  conversation: ctx.recent,
  order: ctx.order && { unconfirmedDraft: ctx.order.isDraft || undefined, stillNeeded: ctx.order.missing?.length ? ctx.order.missing.map((f) => ASK_FOR[f]) : undefined, product: ctx.order.item, quantity: ctx.order.quantity, status: ctx.order.status, total: ctx.order.total, paid: ctx.order.paid, balance: ctx.order.balance, payment: ctx.order.paymentText, delivery: ctx.order.deadlineText, customisation: ctx.order.customisation },
});

// Every amount, weekday, month and clock time in a reply has to come from the context (or the customer's own words).
export function grounded(reply, ctx) {
  const known = JSON.stringify(ctx).toLowerCase();
  for (const a of reply.matchAll(/(?:₹|rs\.?\s?)\s?([\d,]+(?:\.\d+)?)/gi)) {
    const n = Number(a[1].replace(/,/g, '')); const o = ctx.order;
    if (![o?.total, o?.paid, o?.balance, o?.pending].some((v) => typeof v === 'number' && round2(v) === round2(n)) && !known.includes(a[1].toLowerCase())) return false;
  }
  for (const w of reply.matchAll(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b\d{1,2}[:.]\d{2}\s?(?:am|pm)?\b|\b\d{1,2}\s?(?:am|pm)\b/gi)) {
    if (!known.includes(w[0].toLowerCase())) return false;
  }
  return !/\b(is|are|has been) (confirmed|ready|dispatched|shipped)\b/i.test(reply) || /confirmed|ready|dispatched|shipped/.test(known) || Boolean(ctx.order && ctx.order.status === 'completed');
}

// Turns the model's JSON into at most three clean, grounded suggestions (or none, so the caller falls back to the rules).
export function cleanSuggestions(raw, ctx) {
  const list = Array.isArray(raw?.replies) ? raw.replies : [];
  const seen = new Set();
  return list.map((x) => (typeof x === 'string' ? x.trim().replace(/^["“]|["”]$/g, '') : '')).filter((x) => x.length >= 2 && x.length <= 300 && !seen.has(x) && seen.add(x) && grounded(x, ctx))
    .slice(0, 3).map((text, i) => ({ id: `s${i + 1}`, text }));
}
