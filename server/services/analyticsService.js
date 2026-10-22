// Monthly business insights. Pure functions of (orders, settings, month, now): no I/O, no LLM, no guessing.
//
// What the data model can and cannot support (see docs/api-contract.md, "GET /api/analytics/monthly"):
//   - Orders have NO price, NO completion timestamp, NO delay reason, NO refund/cost fields and NO customer id. Anything that needs them is
//     returned as { available: false, reason } so the UI can say so instead of showing an invented number.
//   - paymentEvidence entries are the seller's own notes (screenshot refs, transaction refs). They are reported as "recorded notes", never as
//     verified money, and only when they carry an amount.
//   - "Received" means the order's createdAt falls in the month; "due" means its deadline falls in the month. Both use the business timezone.
//   - Scheduling and risk come from computePlan (the same engine as the planner); predicted risk is never reported as an actual late delivery.
import { computePlan, normalizeOrder } from './workloadEngine.js';
import { OPEN_STATUSES } from '../utils/validation.js';
import { zonedParts, zonedTimeToUtc, ymdString } from '../utils/timezone.js';

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const unavailable = (reason) => ({ available: false, reason });
const ok = (value, extra = {}) => ({ available: true, value, ...extra });
const MIN = 60000;
const PLAN_DAYS = 14;

export const isMonth = (m) => typeof m === 'string' && MONTH.test(m);
const shiftMonth = (m, n) => { const [y, mo] = m.split('-').map(Number); const t = y * 12 + (mo - 1) + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
const monthOf = (date, tz) => { const p = zonedParts(date, tz); return `${p.year}-${String(p.month).padStart(2, '0')}`; };
const dayOf = (date, tz) => { const p = zonedParts(date, tz); return ymdString(p); };
const daysIn = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).getUTCDate(); };
const weekIndex = (ymd) => Math.min(4, Math.floor((Number(ymd.slice(8)) - 1) / 7)); // days 1-7, 8-14, 15-21, 22-28, 29+
const weeksOf = (m) => { const n = daysIn(m); return Array.from({ length: Math.ceil(n / 7) }, (_, i) => ({ index: i, label: `${i * 7 + 1}–${Math.min(n, i * 7 + 7)}`, from: i * 7 + 1, to: Math.min(n, i * 7 + 7) })); };
const normItem = (s) => String(s ?? '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
// A customer is only "known" when a contact is recorded. Names alone are never matched.
const contactKey = (o) => { const c = String(o.customerContact ?? '').toLowerCase().replace(/[\s()+-]/g, ''); return c.length >= 5 ? c : null; };
const isDemo = (o) => typeof o.notes === 'string' && o.notes.startsWith('[DEMO]');

function counts(orders, tz, m) {
  const inMonth = (d) => d && monthOf(new Date(d), tz) === m;
  const received = orders.filter((o) => inMonth(o.createdAt));
  return {
    received,
    total: received.length,
    completed: received.filter((o) => o.status === 'completed').length,
    cancelled: received.filter((o) => o.status === 'cancelled').length,
    open: received.filter((o) => OPEN_STATUSES.includes(o.status)).length,
  };
}

export function buildMonthly({ orders: raw, settings, month, now = new Date() }) {
  const tz = settings.timezone;
  const prev = shiftMonth(month, -1);
  const thisMonth = monthOf(now, tz);
  const orders = raw.map((o) => ({ ...o, id: String(o.id ?? o._id) }));
  const cur = counts(orders, tz, month);
  const pre = counts(orders, tz, prev);
  const weeks = weeksOf(month);
  const live = (o) => o.status !== 'cancelled';
  const dueIn = (m) => orders.filter((o) => live(o) && o.deadline && monthOf(new Date(o.deadline), tz) === m);
  const dueNow = dueIn(month);

  // Engine view of open work, for risk and capacity (forward looking from `now`).
  const plan = computePlan({ orders, settings, now, rangeDays: PLAN_DAYS });
  const byId = Object.fromEntries(orders.map((o) => [o.id, o]));

  // --- 1. Overview
  const change = (a, b) => (b >= 3 ? ok(Math.round(((a - b) / b) * 100), { previous: b, current: a }) : unavailable(b === 0 ? 'No orders were received in the previous month.' : 'The previous month has fewer than 3 orders, too few for a meaningful comparison.'));
  const overview = {
    received: { ...ok(cur.total), previous: pre.total, change: change(cur.total, pre.total) },
    completed: ok(cur.completed), pending: ok(cur.open), cancelled: ok(cur.cancelled),
    revenue: unavailable('Orders do not store a price, so recorded revenue cannot be calculated.'),
    outstandingBalance: unavailable('Orders do not store a price or an amount paid, so a balance cannot be calculated.'),
    onTimeRate: unavailable('Completion time is not recorded, so on-time delivery cannot be measured. Only orders that are still open past their deadline are known to be late.'),
  };

  // --- 2. Sales
  const products = new Map();
  for (const o of cur.received.filter(live)) {
    const k = normItem(o.item) || 'unnamed';
    const p = products.get(k) ?? { product: o.item.replace(/\s*\([^)]*\)/g, '').trim() || o.item, orders: 0, units: 0 };
    p.orders += 1; p.units += o.quantity ?? 1; products.set(k, p);
  }
  const bestSellers = [...products.values()].sort((a, b) => b.orders - a.orders || b.units - a.units).slice(0, 6);
  const receivedByWeek = weeks.map((w) => ({ ...w, orders: cur.received.filter((o) => weekIndex(dayOf(new Date(o.createdAt), tz)) === w.index && live(o)).length }));
  const datedWeeks = receivedByWeek.filter((w) => w.orders > 0).length;
  const busiest = datedWeeks >= 2 ? receivedByWeek.reduce((b, w) => (w.orders > b.orders ? w : b), receivedByWeek[0]) : null;
  const known = cur.received.filter((o) => contactKey(o));
  const earlierKeys = new Set(orders.filter((o) => o.createdAt && new Date(o.createdAt) < zonedTimeToUtc({ year: Number(month.slice(0, 4)), month: Number(month.slice(5)), day: 1 }, tz)).map(contactKey).filter(Boolean));
  const returning = known.filter((o) => earlierKeys.has(contactKey(o))).length;
  const sales = {
    weeklyRevenue: unavailable('Orders do not store a price, so revenue by week cannot be shown. Orders received per week is shown instead.'),
    receivedByWeek,
    bestSellers: bestSellers.length ? ok(bestSellers, { basis: 'Orders received in the month, grouped by product name (quantity in brackets ignored), cancelled orders excluded.' }) : unavailable('No orders were received this month.'),
    averageOrderValue: unavailable('Orders do not store a price.'),
    busiestWeek: busiest ? ok(busiest) : unavailable('Orders need to be spread over at least two weeks of the month before a busiest week means anything.'),
    customers: known.length
      ? ok({ identified: known.length, returning, new: known.length - returning, unidentified: cur.total - known.length })
      : unavailable(cur.total ? 'No order has a customer contact recorded, and matching on names alone would be unreliable, so new versus returning customers cannot be told apart.' : 'No orders were received this month.'),
  };

  // --- 3. Fulfilment
  const dueByWeek = weeks.map((w) => {
    const list = dueNow.filter((o) => weekIndex(dayOf(new Date(o.deadline), tz)) === w.index);
    return { ...w, due: list.length, completed: list.filter((o) => o.status === 'completed').length };
  });
  const nowMs = now.getTime();
  const overdueOpen = dueNow.filter((o) => OPEN_STATUSES.includes(o.status) && new Date(o.deadline).getTime() < nowMs);
  const atRisk = plan.risks.filter((r) => byId[r.orderId]).map((r) => {
    const o = byId[r.orderId]; const e = plan.results[r.orderId];
    return { orderId: o.id, customerName: o.customerName, item: o.item, risk: r.risk, kind: r.kind, deadline: e.deadline, expectedFinish: e.scheduledEnd, reason: r.reason };
  });
  const nextStart = (() => { const [y, mo] = shiftMonth(month, 1).split('-').map(Number); return zonedTimeToUtc({ year: y, month: mo, day: 1 }, tz); })();
  const carry = dueNow.filter((o) => OPEN_STATUSES.includes(o.status));
  const fulfilment = {
    dueByWeek,
    due: dueNow.length, dueCompleted: dueNow.filter((o) => o.status === 'completed').length,
    overdueOpen: overdueOpen.map((o) => ({ orderId: o.id, customerName: o.customerName, item: o.item, deadline: o.deadline })),
    atRisk, // PREDICTED by the scheduler for open orders; not an actual late delivery
    averageFulfilmentTime: unavailable('Completion time is not recorded, so time from order to delivery cannot be measured.'),
    lateCompletions: unavailable('Completion time is not recorded, so completed orders cannot be split into on-time and late.'),
    delayReasons: unavailable('Delay reasons are not recorded. Every late order is "unknown" until the app captures one.'),
    carryover: ok(carry.length, { orders: carry.map((o) => ({ orderId: o.id, customerName: o.customerName, item: o.item, deadline: o.deadline })), basis: 'Orders due in this month that are still open (not completed or cancelled) as of now.', monthEnded: nextStart <= now }),
  };

  // --- 4. Payments
  const monthEvidence = orders.flatMap((o) => (o.paymentEvidence ?? []).map((e) => ({ ...e, orderId: o.id }))).filter((e) => e.addedAt && monthOf(new Date(e.addedAt), tz) === month && typeof e.amount === 'number');
  const payStatus = Object.fromEntries(['verified', 'pending', 'unverified', 'rejected'].map((s) => [s, cur.received.filter((o) => live(o) && (o.paymentStatus ?? 'unverified') === s).length]));
  const payments = {
    statusCounts: payStatus,
    recordedNotes: monthEvidence.length ? ok({ count: monthEvidence.length, total: monthEvidence.reduce((s, e) => s + e.amount, 0) }, { basis: "Amounts the seller noted as payment evidence this month. These are notes, not verified payments." }) : unavailable('No payment amounts were noted this month.'),
    advances: unavailable('Advance payments are not captured separately.'),
    refunds: unavailable('Refunds are not captured.'),
    outstanding: unavailable('Needs order prices, which are not stored.'),
    profit: unavailable('Costs are not captured, and profit is never inferred from order values.'),
  };

  // --- 5. Customers
  const byContact = new Map();
  for (const o of orders.filter(live)) { const k = contactKey(o); if (!k) continue; const c = byContact.get(k) ?? { customerName: o.customerName, orders: 0, last: null }; c.orders += 1; if (o.createdAt && (!c.last || o.createdAt > c.last)) c.last = o.createdAt; byContact.set(k, c); }
  const repeat = [...byContact.values()].filter((c) => c.orders > 1).sort((a, b) => b.orders - a.orders);
  const followUps = [];
  for (const o of orders.filter((x) => OPEN_STATUSES.includes(x.status))) {
    if (o.paymentStatus === 'pending') followUps.push({ orderId: o.id, customerName: o.customerName, reason: 'Payment is marked pending on an open order.', suggestion: 'Check whether the payment has arrived.' });
    if (o.prepTimeMinutes == null || !o.deadline) followUps.push({ orderId: o.id, customerName: o.customerName, reason: `The ${o.prepTimeMinutes == null && !o.deadline ? 'preparation time and deadline are' : o.prepTimeMinutes == null ? 'preparation time is' : 'deadline is'} missing, so the order cannot be scheduled.`, suggestion: 'Confirm the missing detail with the customer.' });
  }
  const customers = {
    topBySpend: unavailable('Orders do not store a price, so customers cannot be ranked by spending.'),
    repeatCustomers: repeat.length ? ok(repeat.slice(0, 5)) : unavailable(byContact.size ? 'No identified customer has ordered more than once.' : 'No customer contact is recorded on any order, so repeat customers cannot be identified reliably.'),
    complaints: unavailable('Complaints and rework are not tracked.'),
    reorderReminders: unavailable('Needs a recorded purchase history per customer (a stable contact and several orders) to suggest a repeat-order reminder.'),
    followUps, // drawn from current open orders only; suggestions, never sent automatically
  };

  // --- 6. Capacity (forward looking: the engine plans from now, so this is the next two weeks, whichever month is selected)
  const dueMinutesByDay = {};
  for (const o of orders.filter((x) => OPEN_STATUSES.includes(x.status) && x.deadline && x.prepTimeMinutes != null)) {
    const d = dayOf(new Date(o.deadline), tz); (dueMinutesByDay[d] ??= []).push(o);
  }
  const capDays = plan.days.map((d) => {
    const due = dueMinutesByDay[d.date] ?? [];
    return { date: d.date, capacityMinutes: d.capacityMinutes, plannedMinutes: d.plannedMinutes, dueOrders: due.length, dueMinutes: due.reduce((s, o) => s + o.prepTimeMinutes, 0), overloaded: d.capacityMinutes > 0 && d.plannedMinutes >= d.capacityMinutes, orders: d.orders.map((x) => ({ orderId: x.id, customerName: x.customerName, item: x.item, minutes: x.scheduledMinutes })) };
  });
  const spare = capDays.reduce((s, d) => s + Math.max(0, d.capacityMinutes - d.plannedMinutes), 0);
  const capacity = {
    window: { from: capDays[0]?.date, days: PLAN_DAYS, note: 'The scheduler plans forward from today, so this view always covers the next two weeks.' },
    days: capDays,
    overloadedDates: capDays.filter((d) => d.overloaded).map((d) => d.date),
    sameDayDeadlines: capDays.filter((d) => d.dueOrders > 1).map((d) => ({ date: d.date, orders: d.dueOrders, minutes: d.dueMinutes })),
    spareMinutes: spare,
    perOrderMinutesNote: 'Workload is measured in preparation minutes, not order counts. How many extra orders fit depends on how long each takes.',
    unschedulable: plan.unscheduledOrders.length,
    recurringDelays: unavailable('Repeated delay patterns need several months of completed orders with completion times. Those are not recorded, so only possible bottlenecks (fully booked days above) are shown.'),
  };

  // --- 7. Opportunities: only what the data above supports.
  const opportunities = [];
  const top = bestSellers[0];
  if (top && top.orders >= 2) opportunities.push({ id: 'top-product', insight: `${top.product} was your most ordered product (${top.orders} orders).`, evidence: `${top.orders} of ${cur.received.filter(live).length} orders received in ${month}.`, why: 'Repeated products are the easiest to prepare for in bulk.', action: 'Write a reusable preparation checklist for it.', link: { to: '/orders', label: 'Review orders' } });
  const prevProducts = new Map();
  for (const o of pre.received.filter(live)) prevProducts.set(normItem(o.item), (prevProducts.get(normItem(o.item)) ?? 0) + 1);
  if (pre.received.filter(live).length >= 3) for (const p of bestSellers) { const before = prevProducts.get(normItem(p.product)) ?? 0; if (p.orders >= 2 && p.orders > before) { opportunities.push({ id: `rising-${normItem(p.product)}`, insight: `Orders for ${p.product} rose from ${before} to ${p.orders}.`, evidence: `${prev} versus ${month}. Two months is a small sample, so treat it as a hint.`, why: 'Early notice helps you buy ingredients ahead.', action: 'Check you have stock for the next few weeks.', link: { to: '/orders', label: 'See orders' } }); break; } }
  if (plan.unscheduledOrders.length) opportunities.push({ id: 'missing-details', insight: `${plan.unscheduledOrders.length} open ${plan.unscheduledOrders.length === 1 ? 'order is' : 'orders are'} missing a preparation time or deadline.`, evidence: 'Counted from your open orders right now.', why: 'Orders without both are left out of the schedule, so capacity looks freer than it is.', action: 'Complete the details.', link: { to: '/orders', label: 'Open orders' } });
  if (atRisk.some((r) => r.risk === 'high')) opportunities.push({ id: 'high-risk', insight: `${atRisk.filter((r) => r.risk === 'high').length} open ${atRisk.filter((r) => r.risk === 'high').length === 1 ? 'order is' : 'orders are'} predicted to miss ${atRisk.filter((r) => r.risk === 'high').length === 1 ? 'its' : 'their'} deadline.`, evidence: 'Predicted by the scheduler from your preparation times and working hours (a forecast, not a late delivery).', why: 'Moving a deadline or freeing time now is cheaper than apologising later.', action: 'Review the plan and consider a what-if.', link: { to: '/deadlines', label: 'Open Deadlines' } });
  if (capacity.overloadedDates.length) opportunities.push({ id: 'full-days', insight: `${capacity.overloadedDates.length} of the next ${PLAN_DAYS} days ${capacity.overloadedDates.length === 1 ? 'is' : 'are'} fully booked.`, evidence: 'Planned preparation minutes reach the daily capacity in your settings.', why: 'New orders for those dates would need other work to move.', action: 'Point new customers to a day with spare time.', link: { to: '/calendar', label: 'Open Calendar' } });

  const demoCount = cur.received.filter(isDemo).length;
  const quality = {
    mode: cur.total === 0 ? 'empty' : demoCount === cur.total ? 'demo' : demoCount > 0 ? 'mixed' : 'real',
    ordersInMonth: cur.total,
    incomplete: ['Prices, payments received, completion times, delay reasons, costs and customer ids are not recorded yet, so revenue, on-time rate and customer value are unavailable.'],
    historyMonths: new Set(orders.map((o) => (o.createdAt ? monthOf(new Date(o.createdAt), tz) : null)).filter(Boolean)).size,
  };

  return { month, previousMonth: prev, isCurrentMonth: month === thisMonth, timezone: tz, generatedAt: now.toISOString(), quality, overview, sales, fulfilment, payments, customers, capacity, opportunities };
}
