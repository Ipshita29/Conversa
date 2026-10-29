import { buildStory } from './simulationStory.js';
import { OPEN, STATUS_LABEL } from './format.js';

// Turns the scheduler's two answers for ONE change (the baseline schedule and the simulated one, both from the same POST /planner/simulate
// run) into one row per order for the What-if table. Nothing is estimated here: every deadline, finish time and risk shown is read from the
// scheduler's entries or from the change the user is testing. The inputs are only read, never modified.
const RANK = { low: 0, medium: 1, high: 2 };
const minutes = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 60000);

// The schedule status of one order. `e` is the scheduler's entry for it (absent for finished orders).
export function statusOf(e, order) {
  if (!e) return { label: STATUS_LABEL[order?.status] ?? 'No schedule', tone: 'done' };
  if (e.kind === 'deadline_passed') return { label: 'Overdue', tone: 'late' };
  if (e.kind === 'unschedulable' || e.scheduledEnd == null) return { label: "Can't be scheduled", tone: 'late' };
  if (e.risk === 'high') return { label: 'Late', tone: 'late' };
  if (e.risk === 'medium') return { label: 'Tight', tone: 'warn' };
  return { label: 'On track', tone: 'ok' };
}

// After the change: a problem is only called "Feasible" when the scheduler's new entry is no longer high risk.
function simulatedStatusOf(b, a, order) {
  if (b && a && b.risk === 'high' && a.risk !== 'high') return a.risk === 'low' ? { label: 'Feasible', tone: 'resolved' } : { label: 'Feasible, tight buffer', tone: 'warn' };
  if (b && a && b.risk === 'high' && a.risk === 'high') return { label: a.kind === 'deadline_passed' ? 'Still overdue' : a.scheduledEnd == null ? "Still can't be scheduled" : 'Still late', tone: 'late' };
  return statusOf(a, order);
}

export function buildComparison({ orders, baseline, after, change, byId, tz }) {
  const isNew = change.type === 'add_order';
  const targetId = isNew ? 'change_0' : change.orderId;
  const story = buildStory({ change, baseline, after, byId, tz });
  const textOf = Object.fromEntries(story.rows.map((r) => [r.id, r.text]));
  const before = Object.fromEntries(baseline.schedule.map((e) => [e.orderId, e]));
  const next = Object.fromEntries(after.schedule.map((e) => [e.orderId, e]));

  const make = (id, order, extra = {}) => {
    const b = before[id] ?? null; const a = next[id] ?? null;
    const target = id === targetId;
    const ch = target && !isNew ? change.order : {};
    const orig = { deadline: order?.deadline ?? null, prep: order?.prepTimeMinutes ?? null, finish: b?.scheduledEnd ?? null, status: extra.isNew ? { label: 'Proposed', tone: 'done' } : statusOf(b, order) };
    const sim = { deadline: ch.deadline ?? orig.deadline, prep: ch.prepTimeMinutes ?? orig.prep, finish: a?.scheduledEnd ?? null, status: simulatedStatusOf(b, a, order) };
    const shift = b?.scheduledEnd && a?.scheduledEnd ? minutes(a.scheduledEnd, b.scheduledEnd) : 0;
    const dir = !b || !a ? 'same' : RANK[a.risk] > RANK[b.risk] ? 'worse' : RANK[a.risk] < RANK[b.risk] ? 'better' : 'same';
    const statusChanged = b && a ? b.risk !== a.risk || b.kind !== a.kind : Boolean(extra.isNew);
    const changed = target || Boolean(extra.isNew) || shift !== 0 || statusChanged;
    return { id, name: order?.customerName ?? id, item: order?.item ?? '', quantity: order?.quantity ?? 1, workflow: order?.status, target, orig, sim, shift, dir, changed, statusChanged, note: textOf[id] ?? null, b, a, ...extra };
  };

  const rows = orders.map((o) => make(o.id, o));
  if (isNew) rows.unshift(make('change_0', { customerName: change.order.customerName, item: change.order.item, deadline: change.order.deadline, prepTimeMinutes: change.order.prepTimeMinutes, status: 'pending', quantity: 1 }, { isNew: true }));

  // Impact, counted from the two schedules.
  const live = rows.filter((r) => r.a || r.b);
  const others = live.filter((r) => !r.target);
  const target = rows.find((r) => r.target);
  const beforeHigh = baseline.schedule.filter((e) => e.risk === 'high').length;
  const afterHigh = after.schedule.filter((e) => e.risk === 'high').length;
  const beforeRisk = baseline.schedule.filter((e) => e.risk !== 'low').length;
  const afterRisk = after.schedule.filter((e) => e.risk !== 'low').length;
  const worse = others.filter((r) => r.dir === 'worse');
  const resolved = live.filter((r) => r.b?.risk === 'high' && r.a && r.a.risk !== 'high');
  const stillBad = live.filter((r) => r.b?.risk === 'high' && r.a?.risk === 'high');
  const moved = others.filter((r) => r.shift !== 0 && r.dir !== 'worse');
  const targetFeasible = target?.a ? target.a.risk !== 'high' : false;
  const passes = worse.length === 0 && afterHigh <= beforeHigh && (!isNew || targetFeasible) && Boolean(target?.a);
  return { rows, story, isNew, summary: { changed: rows.filter((r) => r.changed).length, total: rows.length, worse, resolved, stillBad, moved, beforeHigh, afterHigh, beforeRisk, afterRisk, targetFeasible, passes } };
}

export const isOpenOrder = (o) => OPEN.includes(o.status);
