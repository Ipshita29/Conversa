// The three-part "story" behind the Insights page: the money, orders and people in a period; the order rhythm of one week; and three discoveries (the
// crowd-favourite product, the busiest weekday, the most regular customer). Pure functions of their inputs (no I/O, no LLM, nothing invented); the controller
// loads the orders, conversations and payments. Same rules as insightsService: an order belongs to a day by when it was RECEIVED (createdAt) in the business
// timezone; drafts and cancelled orders are never counted.
import { zonedParts, ymdString, addDays, weekdayOf } from '../utils/timezone.js';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayKey = (iso, tz) => ymdString(zonedParts(new Date(iso), tz));
const ymd = (s) => { const [year, month, day] = s.split('-').map(Number); return { year, month, day }; };
const digits = (v) => String(v ?? '').replace(/\D/g, '');
const round2 = (n) => Math.round(n * 100) / 100;
const pct = (now, before) => (before === 0 ? null : Math.round(((now - before) / before) * 100));
const MIN_COMPARE = 3;

// "4 chocolate pastries", "Chocolate Pastries" and "chocolate pastry (box)" are the same product: drop brackets, a leading quantity and plural endings.
export const productKey = (item) => String(item ?? '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/^\s*\d+\s*(x|×)?\s*/, '').replace(/[^a-zÀ-ɏ\s]/g, ' ').split(/\s+/).filter(Boolean).map((w) => (w.length > 3 ? w.replace(/(ies)$/, 'y').replace(/(es|s)$/, '') : w)).join(' ');
const titleCase = (s) => s.replace(/^\s*\d+\s*(x|×)?\s*/, '').replace(/\([^)]*\)/g, '').trim().replace(/^./, (c) => c.toUpperCase());

// People who contacted the business: one person per WhatsApp number or Instagram account that sent at least one message in the period. The same person on both
// channels is merged ONLY when an order links them (an Instagram chat whose order has the same phone number as a WhatsApp chat); a name is never enough.
export function peopleFor({ inbound, conversations }, dates, tz) {
  const set = new Set(dates); const keys = new Map(); // key -> channels
  for (const m of inbound) {
    if (!set.has(dayKey(m.at, tz))) continue;
    const c = conversations[m.conversationId]; if (!c) continue;
    const phone = digits(c.channel === 'whatsapp' ? c.contactId : c.orderContact);
    const key = phone.length >= 5 ? `tel:${phone}` : `${c.channel}:${c.contactId}`;
    (keys.get(key) ?? keys.set(key, new Set()).get(key)).add(c.channel);
  }
  const byChannel = { whatsapp: 0, instagram: 0 }; let merged = 0;
  for (const chs of keys.values()) { for (const ch of chs) byChannel[ch] += 1; if (chs.size > 1) merged += 1; }
  return { value: keys.size, byChannel, merged };
}

export function buildStory({ orders: raw, inbound = [], conversations = {}, collected = {}, settings, dates, prevDates, weekStart, now = new Date() }) {
  const tz = settings.timezone;
  const live = raw.filter((o) => o.status !== 'draft' && o.status !== 'cancelled' && o.createdAt).map((o) => ({ ...o, id: String(o.id ?? o._id) }));
  const within = (set, list = live) => { const s = new Set(set); return list.filter((o) => s.has(dayKey(o.createdAt, tz))); };
  const cur = within(dates); const prev = within(prevDates);

  // ---- 1. money, orders, people -------------------------------------------------------------------------------------------------
  const priced = (l) => l.filter((o) => typeof o.price === 'number');
  const booked = round2(priced(cur).reduce((s, o) => s + o.price, 0));
  const prevBooked = round2(priced(prev).reduce((s, o) => s + o.price, 0));
  const collectedNow = round2(priced(cur).reduce((s, o) => s + Math.min(o.price, Math.max(0, collected[o.id] ?? 0)), 0)); // never more than the order's price
  const money = priced(cur).length
    ? { available: true, booked, collected: collectedNow, outstanding: round2(booked - collectedNow), pricedOrders: priced(cur).length, unpricedOrders: cur.length - priced(cur).length,
        comparison: priced(prev).length >= MIN_COMPARE ? { available: true, previous: prevBooked, change: pct(booked, prevBooked) } : { available: false, reason: 'The previous period has too few priced orders for a fair comparison.' } }
    : { available: false, reason: cur.length ? 'None of these orders has a price yet.' : 'No orders were received in this period.' };
  const ordersCard = { available: true, value: cur.length, comparison: prev.length >= MIN_COMPARE ? { available: true, previous: prev.length, change: pct(cur.length, prev.length) } : { available: false, reason: 'The previous period has too few orders for a fair comparison.' } };
  const ppl = peopleFor({ inbound, conversations }, dates, tz); const pplPrev = peopleFor({ inbound, conversations }, prevDates, tz);
  const people = { available: true, ...ppl, comparison: pplPrev.value >= MIN_COMPARE ? { available: true, previous: pplPrev.value, change: pct(ppl.value, pplPrev.value) } : { available: false, reason: 'The previous period has too few contacts for a fair comparison.' },
    definition: 'Unique people who sent at least one message on WhatsApp or Instagram in this period. Someone on both channels is counted once only when an order links the two; otherwise each account counts as one person.' };

  // ---- 2. one week, Monday to Sunday ----------------------------------------------------------------------------------------------
  const t = zonedParts(now, tz); const today = { year: t.year, month: t.month, day: t.day };
  const mondayOf = (d) => addDays(d, -((weekdayOf(d) + 6) % 7));
  const thisMonday = mondayOf(today);
  const start = weekStart ? mondayOf(ymd(weekStart)) : thisMonday;
  const wdays = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const counts = Object.fromEntries(wdays.map((d) => [ymdString(d), 0]));
  for (const o of live) { const k = dayKey(o.createdAt, tz); if (k in counts) counts[k] += 1; }
  const days = wdays.map((d) => ({ date: ymdString(d), weekday: DAY_NAMES[weekdayOf(d)], orders: counts[ymdString(d)], future: ymdString(d) > ymdString(today) }));
  const week = { from: days[0].date, to: days[6].date, total: days.reduce((s, d) => s + d.orders, 0), days, isCurrent: ymdString(start) === ymdString(thisMonday), prev: ymdString(addDays(start, -7)), next: ymdString(start) === ymdString(thisMonday) ? null : ymdString(addDays(start, 7)) };

  // ---- 3. discoveries -------------------------------------------------------------------------------------------------------------
  // Crowd favourite: the product ordered most often in the period (number of orders; ties go to units, then the one ordered most recently).
  const byProduct = new Map();
  for (const o of cur) { const k = productKey(o.item); if (!k) continue; const e = byProduct.get(k) ?? { key: k, name: titleCase(o.item), orders: 0, units: 0, last: 0, orderIds: [] }; e.orders += 1; e.units += Number(o.quantity) || 1; e.last = Math.max(e.last, +new Date(o.createdAt)); e.orderIds.push(o.id); byProduct.set(k, e); }
  const ranked = [...byProduct.values()].sort((a, b) => b.orders - a.orders || b.units - a.units || b.last - a.last);
  const top = ranked[0];
  const popular = top ? { available: true, product: top.name, orders: top.orders, units: top.units, share: Math.round((top.orders / cur.length) * 100), repeats: top.orders > 1, tiedOnOrders: ranked.filter((r) => r.orders === top.orders).length, distinct: ranked.length, orderIds: top.orderIds, image: null, method: 'Counted by how many orders include the product in this period; when products tie, the one with more units wins.' }
    : { available: false, reason: 'No orders were received in this period.' };

  // Busiest weekday: the weekday on which the most orders were received in the period.
  const byWd = Array(7).fill(0); for (const o of cur) byWd[weekdayOf(ymd(dayKey(o.createdAt, tz)))] += 1;
  const order7 = [1, 2, 3, 4, 5, 6, 0]; const maxN = Math.max(...byWd); const minN = Math.min(...order7.map((d) => byWd[d]));
  const busiest = cur.length >= 2 && maxN > 0
    ? { available: true, weekday: DAY_NAMES[byWd.indexOf(maxN)], orders: maxN, ties: byWd.filter((n) => n === maxN).length, quietest: maxN === minN ? null : { weekday: DAY_NAMES[order7.filter((d) => byWd[d] === minN)[0]], orders: minN }, total: cur.length, perWeekday: order7.map((d) => ({ weekday: DAY_NAMES[d], orders: byWd[d] })) }
    : { available: false, reason: 'Needs at least two orders in this period to see a pattern.' };

  // Most regular customer: the person with the most orders across all of the business's history (not just this period). A customer is the recorded contact
  // when there is one; only an order with no contact is grouped by exact name.
  const byCustomer = new Map();
  for (const o of live) {
    const phone = digits(o.customerContact); const key = phone.length >= 5 ? `tel:${phone}` : `name:${String(o.customerName ?? '').trim().toLowerCase()}`;
    if (key === 'name:') continue;
    const e = byCustomer.get(key) ?? { name: o.customerName, orders: 0, last: null, first: null, basis: phone.length >= 5 ? 'contact' : 'name' };
    e.orders += 1; e.name = o.customerName; const at = new Date(o.createdAt);
    if (!e.last || at > e.last) e.last = at; if (!e.first || at < e.first) e.first = at;
    byCustomer.set(key, e);
  }
  const reg = [...byCustomer.values()].sort((a, b) => b.orders - a.orders || b.last - a.last)[0];
  const regular = reg && reg.orders >= 2 ? { available: true, name: reg.name, orders: reg.orders, lastOrderAt: reg.last.toISOString(), since: reg.first.toISOString(), basis: reg.basis }
    : { available: false, reason: reg ? 'Nobody has ordered more than once yet.' : 'No orders yet.' };

  return { money, orders: ordersCard, people, week, popular, busiest, regular };
}
