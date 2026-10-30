// Turns the scheduler's output into a day's roadmap. Nothing is scheduled here: every start, finish and free window comes from
// computePlan (GET /api/planner); this only lays those blocks out in order and measures the time between them.
const MIN = 60000;
export const MIN_ROOM = 15; // below this a free slot is shown but no rush order is offered

// The ordered rows of one day: booked blocks and the free time between (and after) them.
export function buildDay(day, { schedule, board, orders }) {
  if (!day) return { rows: [], booked: 0, free: 0, capacity: 0 };
  const entry = Object.fromEntries(schedule.map((e) => [e.orderId, e]));
  const meta = Object.fromEntries(board.map((b) => [b.id, b]));
  const byId = Object.fromEntries(orders.map((o) => [o.id, o]));
  const blocks = [...day.orders].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const dayStart = Date.parse(day.startsAt);
  const dayEnd = dayStart + day.capacityMinutes * MIN;

  const rows = [];
  let cursor = dayStart;
  const gap = (from, to) => {
    const minutes = Math.round((to - from) / MIN);
    if (minutes >= 1) rows.push({ type: 'gap', key: `gap-${new Date(from).toISOString()}`, start: new Date(from).toISOString(), end: new Date(to).toISOString(), minutes, canRush: minutes >= MIN_ROOM });
  };
  blocks.forEach((b) => {
    gap(cursor, Date.parse(b.start));
    const e = entry[b.id]; const m = meta[b.id]; const o = byId[b.id];
    rows.push({
      type: 'task', key: `${b.id}-${b.start}`, id: b.id, start: b.start, end: b.end, minutes: b.scheduledMinutes,
      customerName: b.customerName, item: b.item, quantity: o?.quantity ?? m?.quantity ?? 1,
      prep: e?.prepTimeMinutes ?? b.scheduledMinutes, deadline: e?.deadline ?? o?.deadline ?? null,
      section: m?.section ?? 'onTrack', label: m?.label ?? 'On track', reason: m?.reason ?? e?.reason ?? '', risk: e?.risk ?? 'low',
      buffer: e?.bufferMinutes ?? null, isDemo: Boolean(m?.isDemo),
    });
    cursor = Math.max(cursor, Date.parse(b.end));
  });
  gap(cursor, dayEnd);

  const booked = rows.filter((r) => r.type === 'task').reduce((s, r) => s + r.minutes, 0);
  const free = rows.filter((r) => r.type === 'gap').reduce((s, r) => s + r.minutes, 0);
  return { rows, booked, free, capacity: day.capacityMinutes };
}

// What a rush order does, read from the What-if simulation of the real scheduler (POST /api/planner/simulate).
export function rushImpact(sim, orders) {
  const RUSH = 'change_0';
  const mine = sim.planner.schedule.find((e) => e.orderId === RUSH) ?? null;
  const before = Object.fromEntries(sim.baseline.schedule.map((e) => [e.orderId, e]));
  const byId = Object.fromEntries(orders.map((o) => [o.id, o]));
  const moved = [];
  for (const e of sim.planner.schedule) {
    const b = before[e.orderId];
    if (e.orderId === RUSH || !b || !e.scheduledEnd || !b.scheduledEnd) continue;
    const delta = Math.round((Date.parse(e.scheduledEnd) - Date.parse(b.scheduledEnd)) / MIN);
    if (delta !== 0) moved.push({ id: e.orderId, name: byId[e.orderId]?.customerName ?? 'An order', was: b.scheduledEnd, now: e.scheduledEnd, delta, riskBefore: b.risk, riskAfter: e.risk });
  }
  const hurt = sim.comparison.newRisks.filter((r) => r.orderId !== RUSH).map((r) => ({ ...r, name: byId[r.orderId]?.customerName ?? 'An order' }));
  const fits = Boolean(mine?.scheduledEnd) && mine.risk !== 'high' && hurt.length === 0;
  return { mine, moved, hurt, fits, tight: mine?.risk === 'medium' };
}
