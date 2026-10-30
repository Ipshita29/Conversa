// Insights dashboard (the last 7, 30 or 90 days, or a custom period). Pure functions of (orders, settings, now): no I/O, no LLM, nothing invented.
//
// Definitions, kept identical in the UI tooltips:
//   - An order belongs to the period by the day it was RECEIVED (createdAt, in the business timezone), today included.
//   - Cancelled orders are excluded from every figure. Each order is counted once.
//   - Revenue is BOOKED sales: the agreed `price` (the total for the whole order) of those orders. It is not money collected. Orders without
//     a price are left out of revenue and average order value, and are reported separately, never guessed.
//   - A comparison with the previous period (the same number of days just before) is shown only when that period has at least 3 orders
//     (and, for money figures, 3 priced orders). Otherwise it is "not available" rather than a misleading percentage.
//   - Insights come from the numbers above and from the scheduler (computePlan) and are only produced when the data supports them.
//   - ON-TIME DELIVERY is measured only from orders that were really delivered: status Completed, with the moment it was completed
//     (`completedAt`, set when an order is moved to Completed) and a promised deadline. It is placed in the period by the day it was
//     completed. Open orders are never "late deliveries", and orders completed before completedAt existed are left out, never guessed.
//     The rate is shown as soon as there is one such order (it is the real share of them delivered on time); with none it is not available
//     and the dashboard hides the card. A comparison needs at least 3 delivered orders in the previous period.
//   - ORDER STATUS splits every order received in the period (cancelled included, so this total is the KPI total plus cancelled) into four
//     mutually exclusive groups: Completed, Cancelled, At risk (open, and the scheduler rates it medium or high risk) and Pending (the
//     other open orders). They always add up to the total.
import { computePlan } from './workloadEngine.js';
import { zonedParts, ymdString, addDays, weekdayOf, formatInZone } from '../utils/timezone.js';

export const RANGES = [7, 30, 90];
export const MAX_CUSTOM_DAYS = 366;
const MIN_COMPARE = 3;
const OPEN = ['pending', 'confirmed', 'in_progress'];
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const isDemo = (o) => typeof o.notes === 'string' && o.notes.startsWith('[DEMO]');
const normItem = (s) => String(s ?? '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
const dayKey = (iso, tz) => ymdString(zonedParts(new Date(iso), tz));
const pct = (now, before) => Math.round(((now - before) / before) * 100);
const toYmd = (s) => { const [year, month, day] = s.split('-').map(Number); return { year, month, day }; };
const spanDays = (from, to) => Math.round((Date.UTC(...Object.values(toYmd(to)).map((v, i) => (i === 1 ? v - 1 : v))) - Date.UTC(...Object.values(toYmd(from)).map((v, i) => (i === 1 ? v - 1 : v)))) / 86400000) + 1;

// Validates a custom period (business-timezone dates, not in the future, at most a year). Returns { details }.
export function checkCustomRange(from, to, today) {
  const details = [];
  const real = (v) => typeof v === 'string' && YMD.test(v) && !Number.isNaN(Date.parse(v)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
  if (!real(from)) details.push({ field: 'from', message: 'Must be a date in YYYY-MM-DD format.' });
  if (!real(to)) details.push({ field: 'to', message: 'Must be a date in YYYY-MM-DD format.' });
  if (details.length) return { details };
  if (from > to) details.push({ field: 'from', message: 'The start date must be on or before the end date.' });
  else if (to > ymdString(today)) details.push({ field: 'to', message: 'The end date cannot be in the future.' });
  else if (spanDays(from, to) > MAX_CUSTOM_DAYS) details.push({ field: 'from', message: `A custom period can cover at most ${MAX_CUSTOM_DAYS} days.` });
  return { details };
}

export function buildSummary({ orders: raw, settings, days = 7, from, to, now = new Date(), dataset = 'all' }) {
  const tz = settings.timezone;
  const everything = raw.map((o) => ({ ...o, id: String(o.id ?? o._id) }));
  const datasets = { real: everything.filter((o) => !isDemo(o)).length, demo: everything.filter(isDemo).length, selected: dataset };
  const pool = dataset === 'real' ? everything.filter((o) => !isDemo(o)) : dataset === 'demo' ? everything.filter(isDemo) : everything;
  const live = pool.filter((o) => o.status !== 'cancelled' && o.createdAt);

  const t = zonedParts(now, tz);
  const today = { year: t.year, month: t.month, day: t.day };
  // A custom period is [from, to]; otherwise the last `days` days ending today. The previous period is always the same length, just before.
  const last = to ? toYmd(to) : today;
  if (from && to) days = spanDays(from, to);
  const dates = Array.from({ length: days }, (_, i) => ymdString(addDays(last, i - (days - 1))));
  const prevDates = Array.from({ length: days }, (_, i) => ymdString(addDays(last, i - (2 * days - 1))));
  const inSet = (set, list = live) => { const s = new Set(set); return list.filter((o) => s.has(dayKey(o.createdAt, tz))); };
  const received = (set) => inSet(set, pool.filter((o) => o.createdAt)); // every status, cancelled included: the order-status split
  const cur = inSet(dates);
  const prev = inSet(prevDates);

  const priced = (list) => list.filter((o) => typeof o.price === 'number');
  const sum = (list) => Math.round(list.reduce((s, o) => s + o.price, 0) * 100) / 100;
  const cmp = (now_, before, ok, reasonWhenNot) => (ok ? { available: true, previous: before, change: before === 0 ? null : pct(now_, before) } : { available: false, reason: reasonWhenNot });
  const fewPrev = `The previous ${days} days have fewer than ${MIN_COMPARE} orders, too few for a fair comparison.`;
  const fewPrevPriced = `The previous ${days} days have fewer than ${MIN_COMPARE} priced orders, too few for a fair comparison.`;

  const curPriced = priced(cur); const prevPriced = priced(prev);
  const revenue = sum(curPriced);
  const kpis = {
    totalOrders: { available: true, value: cur.length, comparison: cmp(cur.length, prev.length, prev.length >= MIN_COMPARE, fewPrev) },
    completedOrders: { available: true, value: cur.filter((o) => o.status === 'completed').length, comparison: cmp(cur.filter((o) => o.status === 'completed').length, prev.filter((o) => o.status === 'completed').length, prev.length >= MIN_COMPARE, fewPrev) },
    totalRevenue: curPriced.length
      ? { available: true, value: revenue, pricedOrders: curPriced.length, unpricedOrders: cur.length - curPriced.length, comparison: cmp(revenue, sum(prevPriced), prevPriced.length >= MIN_COMPARE, fewPrevPriced) }
      : { available: false, reason: cur.length ? 'None of these orders has a price yet. Add a price to an order to see revenue.' : 'No orders were received in this period.' },
    averageOrderValue: curPriced.length
      ? { available: true, value: Math.round((revenue / curPriced.length) * 100) / 100, pricedOrders: curPriced.length, comparison: cmp(revenue / curPriced.length, prevPriced.length ? sum(prevPriced) / prevPriced.length : 0, prevPriced.length >= MIN_COMPARE, fewPrevPriced) }
      : { available: false, reason: cur.length ? 'No order has a price yet.' : 'No orders were received in this period.' },
  };

  // --- delivery performance: only orders really completed, placed in the period by their completion day
  const deliverable = pool.filter((o) => o.status === 'completed' && o.completedAt && o.deadline);
  const deliveredIn = (set) => { const k = new Set(set); return deliverable.filter((o) => k.has(dayKey(o.completedAt, tz))); };
  const wasOnTime = (o) => new Date(o.completedAt).getTime() <= new Date(o.deadline).getTime();
  const delivered = deliveredIn(dates); const prevDelivered = deliveredIn(prevDates);
  const onTimeN = delivered.filter(wasOnTime).length;
  const rate = (list) => Math.round((list.filter(wasOnTime).length / list.length) * 100);
  kpis.onTimeRate = delivered.length >= 1
    ? { available: true, value: rate(delivered), delivered: delivered.length, onTime: onTimeN, comparison: prevDelivered.length >= MIN_COMPARE ? { available: true, previous: rate(prevDelivered), change: rate(delivered) - rate(prevDelivered), unit: 'points' } : { available: false, reason: `The previous ${days} days have fewer than ${MIN_COMPARE} delivered orders, too few for a fair comparison.` } }
    : { available: false, delivered: 0, reason: 'No delivered orders in this period.' }; // the dashboard hides the card entirely
  const timing = { delivered: delivered.length, onTime: onTimeN, delayed: delivered.length - onTimeN };

  const trend = dates.map((d) => {
    const day = cur.filter((o) => dayKey(o.createdAt, tz) === d);
    const p = priced(day);
    const done = delivered.filter((o) => dayKey(o.completedAt, tz) === d);
    return { date: d, orders: day.length, revenue: p.length ? sum(p) : 0, pricedOrders: p.length, completed: day.filter((o) => o.status === 'completed').length, delivered: done.length, onTime: done.filter(wasOnTime).length };
  });

  const byProduct = new Map();
  for (const o of cur) {
    const k = normItem(o.item) || 'unnamed';
    const row = byProduct.get(k) ?? { product: String(o.item ?? '').replace(/\s*\([^)]*\)/g, '').trim() || o.item, units: 0, orders: 0, pricedOrders: 0, revenue: 0 };
    row.units += o.quantity ?? 1; row.orders += 1;
    if (typeof o.price === 'number') { row.pricedOrders += 1; row.revenue += o.price; }
    byProduct.set(k, row);
  }
  const ranked = [...byProduct.values()].sort((a, b) => b.units - a.units || b.orders - a.orders || a.product.localeCompare(b.product));
  const products = [...byProduct.values()].map((r) => ({ product: r.product, units: r.units, orders: r.orders, revenue: r.pricedOrders ? Math.round(r.revenue * 100) / 100 : null, partial: r.pricedOrders > 0 && r.pricedOrders < r.orders }))
    .sort((a, b) => (b.revenue ?? -1) - (a.revenue ?? -1) || b.units - a.units || a.product.localeCompare(b.product)).slice(0, 8);
  const topProducts = ranked.slice(0, 3).map((r) => ({ product: r.product, units: r.units, orders: r.orders, revenue: r.pricedOrders ? Math.round(r.revenue * 100) / 100 : null, partial: r.pricedOrders > 0 && r.pricedOrders < r.orders }));

  // --- insights: only what the data above (and the scheduler) can honestly support
  const insights = [];
  const plan = computePlan({ orders: pool, settings, now, rangeDays: 14 });
  const riskOf = (o) => plan.results[o.id]?.risk ?? 'low';
  const period = received(dates);
  const open = period.filter((o) => OPEN.includes(o.status));
  const atRisk = open.filter((o) => riskOf(o) !== 'low').length;
  const status = { total: period.length, completed: period.filter((o) => o.status === 'completed').length, cancelled: period.filter((o) => o.status === 'cancelled').length, atRisk, pending: open.length - atRisk };
  const fullDays = plan.days.filter((d) => d.capacityMinutes > 0 && d.plannedMinutes >= d.capacityMinutes).length;
  const lateCount = plan.schedule.filter((e) => e.risk === 'high').length;
  // The nearest real deadline the scheduler is worried about (any open order, not just this period's).
  const worried = plan.schedule.filter((e) => e.risk !== 'low').map((e) => ({ e, o: pool.find((x) => x.id === e.orderId) })).filter((x) => x.o?.deadline)
    .sort((a, b) => new Date(a.o.deadline) - new Date(b.o.deadline))[0];
  if (worried) {
    const { e, o } = worried;
    insights.push({
      id: 'deadline-risk', tone: 'risk', title: e.kind === 'deadline_passed' ? 'An order is past its deadline' : 'Review an approaching deadline',
      finding: `${o.customerName}'s ${normItem(o.item) ? o.item : 'order'} (${formatInZone(new Date(o.deadline), tz)}): ${e.reason}`,
      action: 'Open the plan to see what to make first, or test a change in What-if.', link: { to: '/plan', label: 'Open the plan' },
    });
  }
  if (fullDays > 0 || lateCount > 0) {
    insights.push({
      id: 'overload', tone: 'risk', title: 'Your next two weeks are heavy',
      finding: `${fullDays} of the next 14 days ${fullDays === 1 ? 'is' : 'are'} fully booked${lateCount ? `, and ${lateCount} ${lateCount === 1 ? 'order is' : 'orders are'} predicted to miss ${lateCount === 1 ? 'its' : 'their'} deadline` : ''}.`,
      action: 'Review the plan, or use What-if before you accept another order.', link: { to: lateCount ? '/plan?focus=risk' : '/plan', label: 'Open the plan' },
    });
  }
  if (cur.length >= 5) {
    const byDay = [0, 0, 0, 0, 0, 0, 0];
    cur.forEach((o) => { const p = zonedParts(new Date(o.createdAt), tz); byDay[weekdayOf(p)] += 1; });
    const order = byDay.map((n, d) => [n, d]).sort((a, b) => b[0] - a[0]);
    if (order[0][0] >= 2 && order[0][0] > order[1][0]) {
      insights.push({
        id: 'busiest-day', tone: 'info', title: `${WEEKDAYS[order[0][1]]} is your busiest ordering day`,
        finding: `${order[0][0]} of ${cur.length} orders from the last ${days} days arrived on a ${WEEKDAYS[order[0][1]]}.`,
        action: `Prepare ingredients and clear some time the day before.`, link: { to: '/orders', label: 'See orders' },
      });
    }
  }
  if (ranked[0] && ranked[0].orders >= 2 && (!ranked[1] || ranked[0].units > ranked[1].units) && !insights.some((i) => i.id === 'best-seller')) {
    insights.push({
      id: 'best-seller', tone: 'good', title: `${ranked[0].product} is your best seller`,
      finding: `${ranked[0].units} ${ranked[0].units === 1 ? 'unit' : 'units'} across ${ranked[0].orders} orders in the last ${days} days${topProducts[0].revenue != null ? `, worth ${topProducts[0].revenue.toLocaleString()}` : ''}.`,
      action: 'Keep a ready checklist for it, and consider preparing it in batches.', link: { to: '/orders', label: 'See orders' },
    });
  }
  const unpriced = cur.length - curPriced.length;
  if (unpriced > 0) {
    insights.push({
      id: 'missing-prices', tone: 'info', title: 'Some orders have no price',
      finding: `${unpriced} of ${cur.length} orders from the last ${days} days ${unpriced === 1 ? 'has' : 'have'} no price, so revenue is understated.`,
      action: 'Add the price when you edit an order.', link: { to: '/orders', label: 'Open orders' },
    });
  }

  return {
    range: { days, from: dates[0], to: dates[dates.length - 1], timezone: tz }, generatedAt: now.toISOString(), datasets,
    basis: 'Orders are counted by the day they were received. Cancelled orders are excluded. Revenue is the agreed price of those orders (booked sales, not money collected).',
    kpis, trend, products, topProducts, status, timing, insights: insights.slice(0, 3),
  };
}
