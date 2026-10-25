// The Production board: every open order, sorted by urgency into three sections. Pure functions of (orders, settings, now).
//
//   Overdue   - the promised deadline has passed and the order is still open.
//   Upcoming  - not overdue, and needs preparation soon: it is due today or on the next working day, OR the scheduler says it may
//               not finish in time (a thin buffer or a predicted delay). An order with too little time is never "on track".
//   On track  - not overdue, due further out, and the scheduler (computePlan, the same engine as the plan) finishes it with a safe buffer.
//
// Nothing here is stored or hardcoded per order: adding or editing an order moves it to the right section by itself.
// Orders missing a preparation time or deadline cannot be scheduled, so they are reported separately (`needsDetails`), never guessed.
import { computePlan } from './workloadEngine.js';
import { zonedParts, ymdString, addDays, weekdayOf } from '../utils/timezone.js';
import { formatMinutes } from '../utils/duration.js';

const isDemo = (o) => typeof o.notes === 'string' && o.notes.startsWith('[DEMO]');
const dayKey = (iso, tz) => ymdString(zonedParts(new Date(iso), tz));
const plural = (n, one, many) => (n === 1 ? one : many);

export const BOARD_LABEL = { overdue: 'Overdue', onTrack: 'On track', upcoming: 'Upcoming' };

// How long ago a deadline passed, in the unit a baker would say it in: "1 day", "5 hours", "20 minutes".
export function overdueFor(minutes) {
  if (minutes >= 24 * 60) { const d = Math.floor(minutes / (24 * 60)); return `${d} ${plural(d, 'day', 'days')}`; }
  if (minutes >= 60) { const h = Math.floor(minutes / 60); return `${h} ${plural(h, 'hour', 'hours')}`; }
  const m = Math.max(1, minutes); return `${m} ${plural(m, 'minute', 'minutes')}`;
}

// The first day on which work happens, today included: today if it is a working day, otherwise the next one.
const nextWorkingDay = (today, settings, after = false) => {
  let d = after ? addDays(today, 1) : today;
  for (let i = 0; i < 8 && !settings.workingDays.includes(weekdayOf(d)); i++) d = addDays(d, 1);
  return d;
};

export function buildBoard({ orders: raw, settings, now = new Date(), dataset = 'all' }) {
  const tz = settings.timezone;
  const everything = raw.map((o) => ({ ...o, id: String(o.id ?? o._id) }));
  const datasets = { real: everything.filter((o) => !isDemo(o)).length, demo: everything.filter(isDemo).length, selected: dataset };
  // Only the chosen orders are scheduled, so demo orders can never take capacity from real ones (or the reverse).
  const pool = dataset === 'real' ? everything.filter((o) => !isDemo(o)) : dataset === 'demo' ? everything.filter(isDemo) : everything;
  const byId = Object.fromEntries(pool.map((o) => [o.id, o]));
  const plan = computePlan({ orders: pool, settings, now, rangeDays: 14 });

  const t = zonedParts(now, tz);
  const today = { year: t.year, month: t.month, day: t.day };
  const todayKey = ymdString(today);
  const soonKey = ymdString(nextWorkingDay(today, settings, true)); // the next working day after today
  const calDiff = (key) => Math.round((Date.parse(`${key}T00:00:00Z`) - Date.parse(`${todayKey}T00:00:00Z`)) / 86400000);
  const weekdayName = (key) => new Date(`${key}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long' });

  const sections = { overdue: [], onTrack: [], upcoming: [] };
  for (const e of plan.schedule) {
    const o = byId[e.orderId];
    if (!o) continue;
    const dueKey = dayKey(o.deadline, tz);
    const hour = zonedParts(new Date(o.deadline), tz).hour;
    let section; let reason;
    if (e.kind === 'deadline_passed') {
      section = 'overdue';
      reason = `${overdueFor(Math.round((now.getTime() - Date.parse(o.deadline)) / 60000))} overdue — the promised deadline has passed and the order is still incomplete.`;
    } else if (e.kind === 'late' || e.kind === 'unschedulable') {
      section = 'upcoming';
      reason = e.scheduledEnd ? `May not finish in time — the scheduler estimates ${formatMinutes(e.shortfallMinutes)} after the deadline, so it needs a preparation slot now.` : 'May not finish in time — it does not fit in the next 60 working days.';
    } else if (e.kind === 'tight' && dueKey > soonKey) {
      section = 'upcoming';
      reason = `Thin buffer — only ${formatMinutes(e.bufferMinutes)} to spare, so it needs preparation soon.`;
    } else if (dueKey <= soonKey) {
      section = 'upcoming';
      const when = dueKey === todayKey ? 'today' : calDiff(dueKey) === 1 ? 'tomorrow' : `on ${weekdayName(dueKey)}`;
      reason = dueKey === todayKey ? 'Due today — start preparing now so it is ready in time.'
        : hour < 12 ? `Deadline approaching — this order is due ${when} morning and should be prepared before less urgent orders.`
          : `Prepare soon — the order is due ${when} and should be assigned an upcoming preparation slot.`;
      // The scheduler's own buffer, stated plainly when it is thin, so a tight order is never described as comfortable.
      if (e.kind === 'tight') reason += e.bufferMinutes <= 0 ? ' There is no time to spare.' : ` Only ${formatMinutes(e.bufferMinutes)} to spare.`;
    } else {
      section = 'onTrack';
      reason = calDiff(dueKey) >= 3 ? 'Plenty of time — the production schedule leaves sufficient time before delivery.' : 'Comfortable buffer — there is enough production time to finish before the deadline.';
    }
    sections[section].push({
      id: o.id, customerName: o.customerName, item: o.item, quantity: o.quantity ?? 1, deadline: o.deadline instanceof Date ? o.deadline.toISOString() : o.deadline,
      prepTimeMinutes: o.prepTimeMinutes ?? null, status: o.status, section, label: BOARD_LABEL[section], reason, isDemo: isDemo(o),
      predictedFinish: e.scheduledEnd, scheduledStart: e.scheduledStart, bufferMinutes: e.bufferMinutes, risk: e.risk,
    });
  }
  const byDeadline = (a, b) => Date.parse(a.deadline) - Date.parse(b.deadline) || Date.parse(a.scheduledStart) - Date.parse(b.scheduledStart);
  sections.overdue.sort(byDeadline); // the longest overdue first
  sections.onTrack.sort(byDeadline); // nearest deadline first
  sections.upcoming.sort(byDeadline); // earliest deadline (and so the earliest required preparation) first

  const needsDetails = plan.unscheduledOrders.filter((u) => byId[u.id]).map((u) => ({ id: u.id, customerName: byId[u.id].customerName, item: byId[u.id].item, reason: u.reason }));
  const counts = { overdue: sections.overdue.length, onTrack: sections.onTrack.length, upcoming: sections.upcoming.length };
  return { generatedAt: now.toISOString(), timezone: tz, datasets, sections, counts, total: counts.overdue + counts.onTrack + counts.upcoming, needsDetails };
}
