import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getPlanner, listOrders } from '../services/api.js';
import useAsync from '../hooks/useAsync.js';
import { dateKey, formatMinutes, formatTimeInTz, OPEN } from '../utils/format.js';
import PageHeader from '../components/PageHeader.jsx';
import StateMessage from '../components/StateMessage.jsx';
import { RiskBadge, StatusBadge } from '../components/Badge.jsx';
import '../css/Calendar.css';

// Calendar arithmetic on YYYY-MM-DD strings (no timezone drift).
const parse = (s) => new Date(`${s}T00:00:00Z`);
const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const mondayOf = (s) => addDays(s, -((parse(s).getUTCDay() + 6) % 7));
const label = (s, o) => parse(s).toLocaleDateString(undefined, { timeZone: 'UTC', ...o });

export default function Calendar() {
  const { status, data, error, reload } = useAsync(async () => {
    const [planner, orders] = await Promise.all([getPlanner({ days: 30 }), listOrders({ pageSize: 100 })]);
    return { planner, orders: orders.items };
  });
  const [weekStart, setWeekStart] = useState(null);
  const [picked, setPicked] = useState(null);

  const header = <PageHeader eyebrow="Calendar" title="Deadlines and scheduled work." subtitle="Your scheduled preparation and every deadline, week by week." />;
  const view = useMemo(() => {
    if (!data) return null;
    const { planner, orders } = data;
    const tz = planner.range.timezone;
    const today = planner.days[0].date;
    const start = weekStart ?? mondayOf(today);
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i)).map((date) => ({
      date,
      plan: planner.days.find((d) => d.date === date) ?? null,
      deadlines: orders.filter((o) => o.deadline && o.status !== 'cancelled' && dateKey(o.deadline, tz) === date).sort((a, b) => new Date(a.deadline) - new Date(b.deadline)),
    }));
    return { planner, orders, tz, today, start, days, horizonEnd: planner.days[planner.days.length - 1].date };
  }, [data, weekStart]);

  if (status === 'loading' && !data) return <section className="page calendar">{header}<StateMessage kind="loading" message="Loading schedule…" /></section>;
  if (status === 'error') return <section className="page calendar">{header}<StateMessage kind="error" message={`Couldn't load the schedule. ${error.message}`} onRetry={reload} /></section>;

  const { planner, orders, tz, today, start, days, horizonEnd } = view;
  const openOrders = orders.filter((o) => OPEN.includes(o.status));
  const selected = days.find((d) => d.date === (picked ?? (days.some((d2) => d2.date === today) ? today : start))) ?? days[0];
  const byId = Object.fromEntries(orders.map((o) => [o.id, o]));
  const needs = planner.unscheduledOrders.map((u) => byId[u.id]).filter(Boolean);
  const shift = (n) => { setWeekStart(addDays(start, n * 7)); setPicked(null); };

  return (
    <section className="page calendar">
      {header}
      {orders.length === 0 && <StateMessage message="No orders yet, so there is nothing on the calendar." />}
      {orders.length > 0 && (
        <>
          <div className="cal-nav">
            <h2 aria-live="polite">{label(start, { day: 'numeric', month: 'long' })} – {label(addDays(start, 6), { day: 'numeric', month: 'long', year: 'numeric' })}</h2>
            <div className="cal-nav-btns">
              <button type="button" className="btn btn-sm" onClick={() => shift(-1)} aria-label="Previous week"><ChevronLeft size={15} aria-hidden="true" /></button>
              <button type="button" className="btn btn-sm" onClick={() => { setWeekStart(null); setPicked(null); }}>Today</button>
              <button type="button" className="btn btn-sm" onClick={() => shift(1)} aria-label="Next week"><ChevronRight size={15} aria-hidden="true" /></button>
            </div>
          </div>

          <div className="week" role="list">
            {days.map((d) => {
              const full = d.plan && d.plan.capacityMinutes > 0 && d.plan.plannedMinutes >= d.plan.capacityMinutes;
              const pct = d.plan && d.plan.capacityMinutes ? Math.min(100, (d.plan.plannedMinutes / d.plan.capacityMinutes) * 100) : 0;
              return (
                <button key={d.date} type="button" role="listitem" className={`day${d.date === today ? ' is-today' : ''}${selected.date === d.date ? ' is-selected' : ''}${d.plan && d.plan.capacityMinutes === 0 ? ' is-off' : ''}`} onClick={() => setPicked(d.date)} aria-pressed={selected.date === d.date}>
                  <span className="day-head"><span className="day-dow">{label(d.date, { weekday: 'short' })}</span><span className="day-num">{label(d.date, { day: 'numeric' })}</span></span>
                  {d.plan ? (
                    <>
                      <span className="meter"><span className={full ? 'meter-fill over' : 'meter-fill'} style={{ width: `${pct}%`, display: 'block' }} /></span>
                      <span className="day-cap">{d.plan.capacityMinutes === 0 ? 'Day off' : `${formatMinutes(d.plan.plannedMinutes)} / ${formatMinutes(d.plan.capacityMinutes)}`}</span>
                    </>
                  ) : <span className="day-cap muted">{d.date < today ? 'Past' : 'Beyond schedule'}</span>}
                  <span className="day-deadlines">
                    {d.deadlines.slice(0, 3).map((o) => (
                      <span key={o.id} className={`dl dl-${o.risk ?? 'none'}${o.status === 'completed' ? ' dl-done' : ''}`}><i aria-hidden="true" />{o.customerName.split(' ')[0]}</span>
                    ))}
                    {d.deadlines.length > 3 && <span className="dl-more">+{d.deadlines.length - 3} more</span>}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="muted cal-foot">Scheduled work is available through {label(horizonEnd, { day: 'numeric', month: 'short' })}. Marker shapes show risk: ◆ high, ▲ medium, ● low.</p>

          <div className="day-detail">
            <h3>{label(selected.date, { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
            {selected.plan === null && <p className="muted">{selected.date < today ? 'This day has passed.' : 'No schedule is available this far ahead.'}</p>}
            <div className="detail-cols">
              <div>
                <h4>Scheduled work</h4>
                {selected.plan?.orders.length ? (
                  <ul className="plain-list detail-list">{selected.plan.orders.map((o) => (
                    <li key={o.id}><strong>{o.customerName}</strong><span>{o.item}</span><small className="muted">{formatMinutes(o.scheduledMinutes)} of preparation</small></li>
                  ))}</ul>
                ) : <p className="muted">{selected.plan?.capacityMinutes === 0 ? 'A day off.' : 'Nothing scheduled.'}</p>}
              </div>
              <div>
                <h4>Deadlines</h4>
                {selected.deadlines.length ? (
                  <ul className="plain-list detail-list">{selected.deadlines.map((o) => (
                    <li key={o.id}><strong>{o.customerName}</strong><span>{o.item} · due {formatTimeInTz(o.deadline, tz)}</span>
                      <span className="detail-badges"><StatusBadge status={o.status} />{OPEN.includes(o.status) && <RiskBadge risk={o.risk} />}</span></li>
                  ))}</ul>
                ) : <p className="muted">No deadlines.</p>}
              </div>
            </div>
          </div>

          {needs.length > 0 && (
            <div className="cal-needs">
              <h4>Not on the calendar yet</h4>
              <p className="muted">These open orders have no deadline or preparation time, so no date is invented for them: {needs.map((o) => o.customerName).join(', ')}.</p>
            </div>
          )}
          {openOrders.length === 0 && <p className="muted">There are no open orders to schedule.</p>}
        </>
      )}
    </section>
  );
}
