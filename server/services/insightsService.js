// Insights dashboard (last 7 or 30 days). Pure functions of (orders, settings, now): no I/O, no LLM, nothing invented.
//
// Definitions, kept identical in the UI tooltips:
//   - An order belongs to the period by the day it was RECEIVED (createdAt, in the business timezone), today included.
//   - Cancelled orders are excluded from every figure. Each order is counted once.
//   - Revenue is BOOKED sales: the agreed `price` (the total for the whole order) of those orders. It is not money collected. Orders without
//     a price are left out of revenue and average order value, and are reported separately, never guessed.
//   - A comparison with the previous period (the same number of days just before) is shown only when that period has at least 3 orders
//     (and, for money figures, 3 priced orders). Otherwise it is "not available" rather than a misleading percentage.
//   - Insights come from the numbers above and from the scheduler (computePlan) and are only produced when the data supports them.
import { computePlan } from './workloadEngine.js';
import { zonedParts, ymdString, addDays, weekdayOf } from '../utils/timezone.js';

export const RANGES = [7, 30];
const MIN_COMPARE = 3;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const isDemo = (o) => typeof o.notes === 'string' && o.notes.startsWith('[DEMO]');
const normItem = (s) => String(s ?? '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
const dayKey = (iso, tz) => ymdString(zonedParts(new Date(iso), tz));
const pct = (now, before) => Math.round(((now - before) / before) * 100);

export function buildSummary({ orders: raw, settings, days = 7, now = new Date(), dataset = 'all' }) {
  const tz = settings.timezone;
  const everything = raw.map((o) => ({ ...o, id: String(o.id ?? o._id) }));
  const datasets = { real: everything.filter((o) => !isDemo(o)).length, demo: everything.filter(isDemo).length, selected: dataset };
  const pool = dataset === 'real' ? everything.filter((o) => !isDemo(o)) : dataset === 'demo' ? everything.filter(isDemo) : everything;
  const live = pool.filter((o) => o.status !== 'cancelled' && o.createdAt);

  const t = zonedParts(now, tz);
  const today = { year: t.year, month: t.month, day: t.day };
  const dates = Array.from({ length: days }, (_, i) => ymdString(addDays(today, i - (days - 1))));
  const prevDates = Array.from({ length: days }, (_, i) => ymdString(addDays(today, i - (2 * days - 1))));
  const inSet = (set) => { const s = new Set(set); return live.filter((o) => s.has(dayKey(o.createdAt, tz))); };
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

  const trend = dates.map((d) => {
    const day = cur.filter((o) => dayKey(o.createdAt, tz) === d);
    const p = priced(day);
    return { date: d, orders: day.length, revenue: p.length ? sum(p) : 0, pricedOrders: p.length };
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
  const topProducts = ranked.slice(0, 3).map((r) => ({ product: r.product, units: r.units, orders: r.orders, revenue: r.pricedOrders ? Math.round(r.revenue * 100) / 100 : null, partial: r.pricedOrders > 0 && r.pricedOrders < r.orders }));

  // --- insights: only what the data above (and the scheduler) can honestly support
  const insights = [];
  const plan = computePlan({ orders: pool, settings, now, rangeDays: 14 });
  const fullDays = plan.days.filter((d) => d.capacityMinutes > 0 && d.plannedMinutes >= d.capacityMinutes).length;
  const lateCount = plan.schedule.filter((e) => e.risk === 'high').length;
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
  if (ranked[0] && ranked[0].orders >= 2 && (!ranked[1] || ranked[0].units > ranked[1].units)) {
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
    kpis, trend, topProducts, insights: insights.slice(0, 3),
  };
}
