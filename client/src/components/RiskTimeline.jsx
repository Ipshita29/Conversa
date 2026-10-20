import { formatDayInTz, formatMinutes } from '../utils/format.js';

// Draws ONLY what the scheduler returned: each day's capacity window (startsAt + capacityMinutes) and the exact
// time blocks it placed. Earlier orders = caramel, this order = blue, the part after the deadline = muted red.
export default function RiskTimeline({ entry, planner, tz }) {
  const deadline = entry.deadline ? Date.parse(entry.deadline) : null;
  const days = [...new Set((entry.blocks ?? []).map((b) => b.date))]
    .map((date) => planner.days.find((d) => d.date === date))
    .filter((d) => d && d.startsAt && d.capacityMinutes > 0);
  if (days.length === 0) return null; // no scheduler detail for these days: show nothing rather than guess

  const shownDays = days.slice(0, 5);
  return (
    <figure className="tl" aria-label="Where this order sits in your working days">
      <figcaption>Where it sits in your working days <small>(times in {tz})</small></figcaption>
      {shownDays.map((day) => {
        const t0 = Date.parse(day.startsAt);
        const span = day.capacityMinutes * 60000;
        const pct = (t) => Math.max(0, Math.min(100, ((t - t0) / span) * 100));
        const segs = [];
        for (const o of day.orders) {
          const s = Date.parse(o.start); const e = Date.parse(o.end);
          if (o.id !== entry.orderId) { segs.push({ kind: 'other', left: pct(s), width: pct(e) - pct(s), label: `${o.customerName} · ${formatMinutes(o.scheduledMinutes)}` }); continue; }
          const cut = deadline === null ? e : Math.max(s, Math.min(e, deadline));
          if (cut > s) segs.push({ kind: 'self', left: pct(s), width: pct(cut) - pct(s), label: `This order · ${formatMinutes(Math.round((cut - s) / 60000))}` });
          if (e > cut) segs.push({ kind: 'late', left: pct(cut), width: pct(e) - pct(cut), label: `After the deadline · ${formatMinutes(Math.round((e - cut) / 60000))}` });
        }
        const marker = deadline !== null && deadline >= t0 && deadline <= t0 + span ? pct(deadline) : null;
        const summary = `${formatDayInTz(day.date)}: ${segs.map((s) => s.label).join('; ')}${marker !== null ? '; the deadline falls on this day' : ''}`;
        return (
          <div key={day.date} className="tl-day">
            <span className="tl-label">{formatDayInTz(day.date)}<small>{formatMinutes(day.plannedMinutes)} of {formatMinutes(day.capacityMinutes)} booked</small></span>
            <div className="tl-bar" role="img" aria-label={summary}>
              {segs.map((s, i) => <i key={i} className={`tl-seg tl-${s.kind}`} style={{ left: `${s.left}%`, width: `${s.width}%` }} title={s.label} />)}
              {marker !== null && <b className="tl-deadline" style={{ left: `${marker}%` }} title="Promised deadline" />}
            </div>
          </div>
        );
      })}
      {days.length > shownDays.length && <p className="muted tl-more">+{days.length - shownDays.length} more working {days.length - shownDays.length === 1 ? 'day' : 'days'}</p>}
      <ul className="tl-legend">
        <li><i className="tl-seg tl-other" /> Earlier orders</li>
        <li><i className="tl-seg tl-self" /> This order</li>
        <li><i className="tl-seg tl-late" /> After the deadline</li>
        <li><i className="tl-deadline-key" /> Promised deadline</li>
      </ul>
    </figure>
  );
}
