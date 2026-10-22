import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ArrowRight } from 'lucide-react';
import { getPlanner, listOrders } from '../services/api.js';
import useAsync from '../hooks/useAsync.js';
import { dateKey, formatMinutes, formatTimeInTz, OPEN, isDemoOrder } from '../utils/format.js';
import PageHeader from '../components/PageHeader.jsx';
import StateMessage from '../components/StateMessage.jsx';
import { RiskBadge, StatusBadge } from '../components/Badge.jsx';
import '../css/Calendar.css';

// Calendar arithmetic on YYYY-MM-DD strings (no timezone drift).
const parse = (s) => new Date(`${s}T00:00:00Z`);
const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const mondayOf = (s) => addDays(s, -((parse(s).getUTCDay() + 6) % 7));
const label = (s, o) => parse(s).toLocaleDateString(undefined, { timeZone: 'UTC', ...o });
const shiftMonth = (m, n) => { const [y, mo] = m.split('-').map(Number); const t = y * 12 + mo - 1 + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SHAPE = { high: '◆', medium: '▲', low: '●' };
const MAX_CHIPS = 2;

// Colour comes from the order: red for open work that is high-risk or overdue, green for completed, blue for in progress, caramel otherwise.
const tone = (o) => (o.status === 'completed' ? 'done' : OPEN.includes(o.status) && o.risk === 'high' ? 'late' : o.status === 'in_progress' ? 'progress' : 'pending');
const first = (name) => name.split(' ')[0];

export default function Calendar() {
  const { status, data, error, reload } = useAsync(async () => {
    const [planner, orders] = await Promise.all([getPlanner({ days: 30 }), listOrders({ pageSize: 100 })]);
    return { planner, orders: orders.items };
  });
  const [month, setMonth] = useState(null);
  const [picked, setPicked] = useState(null);

  const header = <PageHeader eyebrow="Calendar" title="Deadlines and scheduled work." subtitle="Every deadline and the preparation time the scheduler has set aside, month by month." />;
  const view = useMemo(() => {
    if (!data) return null;
    const { planner, orders } = data;
    const tz = planner.range.timezone;
    const today = planner.days[0].date;
    const shown = month ?? today.slice(0, 7);
    const gridStart = mondayOf(`${shown}-01`);
    const monthEnd = addDays(`${shown}-01`, new Date(Date.UTC(Number(shown.slice(0, 4)), Number(shown.slice(5)), 0)).getUTCDate() - 1);
    const weeks = Math.ceil(((parse(addDays(mondayOf(monthEnd), 6)) - parse(gridStart)) / 86400000 + 1) / 7);
    const planByDate = Object.fromEntries(planner.days.map((d) => [d.date, d]));
    const live = orders.filter((o) => o.deadline && o.status !== 'cancelled');
    const days = Array.from({ length: weeks * 7 }, (_, i) => addDays(gridStart, i)).map((date) => {
      const plan = planByDate[date] ?? null;
      return {
        date, plan, inMonth: date.slice(0, 7) === shown,
        deadlines: live.filter((o) => dateKey(o.deadline, tz) === date).sort((a, b) => new Date(a.deadline) - new Date(b.deadline)),
        prep: (plan?.orders ?? []).filter((p) => orders.some((o) => o.id === p.id)),
      };
    });
    return { planner, orders, tz, today, shown, days, horizonEnd: planner.days[planner.days.length - 1].date };
  }, [data, month]);

  if (status === 'loading' && !data) return <section className="page calendar">{header}<StateMessage kind="loading" message="Loading schedule…" /></section>;
  if (status === 'error') return <section className="page calendar">{header}<StateMessage kind="error" message={`Couldn't load the schedule. ${error.message}`} onRetry={reload} /></section>;

  const { planner, orders, tz, today, shown, days, horizonEnd } = view;
  const byId = Object.fromEntries(orders.map((o) => [o.id, o]));
  const needs = planner.unscheduledOrders.map((u) => ({ order: byId[u.id], reason: u.reason })).filter((x) => x.order);
  const selected = days.find((d) => d.date === (picked ?? (days.some((d2) => d2.date === today) ? today : `${shown}-01`))) ?? days[0];
  const go = (n) => { setMonth(shiftMonth(shown, n)); setPicked(null); };
  const MISSING = { missing_prep_time: 'preparation time', missing_deadline: 'deadline', missing_both: 'preparation time and deadline' };

  return (
    <section className="page calendar">
      {header}
      {orders.length === 0 && <StateMessage message="No orders yet, so there is nothing on the calendar." />}
      {orders.length > 0 && (
        <>
          <div className="cal-nav">
            <h2 aria-live="polite">{label(`${shown}-01`, { month: 'long', year: 'numeric' })}</h2>
            <div className="cal-nav-btns">
              <button type="button" className="btn btn-sm" onClick={() => go(-1)} aria-label="Previous month"><ChevronLeft size={15} aria-hidden="true" /></button>
              <button type="button" className="btn btn-sm" onClick={() => { setMonth(null); setPicked(null); }} disabled={shown === today.slice(0, 7) && !picked}>Today</button>
              <button type="button" className="btn btn-sm" onClick={() => go(1)} aria-label="Next month"><ChevronRight size={15} aria-hidden="true" /></button>
            </div>
          </div>

          <ul className="cal-legend" aria-label="Colour key">
            <li><i className="lg lg-pending" />Pending</li><li><i className="lg lg-progress" />In progress</li><li><i className="lg lg-done" />Completed</li><li><i className="lg lg-late" />High risk or overdue</li>
            <li><i className="lg lg-prep" />Preparation block</li><li><i className="lg lg-off" />Day off</li>
          </ul>

          <div className="cal-layout">
            <div className="cal" role="grid" aria-label={`Calendar, ${label(`${shown}-01`, { month: 'long', year: 'numeric' })}`}>
              <div className="cal-dow" role="row">{WEEKDAYS.map((w) => <span key={w} role="columnheader">{w}</span>)}</div>
              <div className="cal-grid">
                {days.map((d) => {
                  const off = d.plan && d.plan.capacityMinutes === 0;
                  const full = d.plan && d.plan.capacityMinutes > 0 && d.plan.plannedMinutes >= d.plan.capacityMinutes;
                  const chips = [...d.deadlines.map((o) => ({ key: `d${o.id}`, kind: 'due', o })), ...d.prep.map((p) => ({ key: `p${p.id}`, kind: 'prep', o: byId[p.id], minutes: p.scheduledMinutes }))];
                  const sel = selected.date === d.date;
                  return (
                    <button key={d.date} type="button" role="gridcell" className={`cal-cell${d.inMonth ? '' : ' is-outside'}${d.date === today ? ' is-today' : ''}${d.date < today ? ' is-past' : ''}${off ? ' is-off' : ''}${sel ? ' is-selected' : ''}`}
                      onClick={() => setPicked(d.date)} aria-pressed={sel} aria-label={`${label(d.date, { weekday: 'long', day: 'numeric', month: 'long' })}${d.date === today ? ', today' : ''}${off ? ', day off' : ''}${chips.length ? `, ${d.deadlines.length} ${d.deadlines.length === 1 ? 'deadline' : 'deadlines'}, ${d.prep.length} preparation ${d.prep.length === 1 ? 'block' : 'blocks'}` : ''}`}>
                      <span className="cal-num">{label(d.date, { day: 'numeric' })}</span>
                      {full && <span className="cal-full" title="Fully booked" aria-hidden="true" />}
                      <span className="cal-chips">
                        {chips.slice(0, MAX_CHIPS).map((c) => (
                          <span key={c.key} className={`chip chip-${tone(c.o)}${c.kind === 'prep' ? ' chip-prep' : ''}`} title={c.kind === 'due' ? `Due ${formatTimeInTz(c.o.deadline, tz)}: ${c.o.customerName}, ${c.o.item}` : `Preparation: ${c.o.customerName}, ${formatMinutes(c.minutes)}`}>
                            {c.kind === 'due' ? <><b aria-hidden="true">{SHAPE[c.o.risk] ?? '•'}</b>{first(c.o.customerName)}<small>{formatTimeInTz(c.o.deadline, tz)}</small></> : <>{first(c.o.customerName)}<small>{formatMinutes(c.minutes)}</small></>}
                          </span>
                        ))}
                        {chips.length > MAX_CHIPS && <span className="chip-more">+{chips.length - MAX_CHIPS} more</span>}
                      </span>
                      {chips.length > 0 && <span className="cal-dots" aria-hidden="true">{chips.slice(0, 4).map((c) => <i key={c.key} className={`lg lg-${tone(c.o)}`} />)}</span>}
                    </button>
                  );
                })}
              </div>
              <p className="muted cal-foot">Preparation blocks come from the scheduler and exist from today through {label(horizonEnd, { day: 'numeric', month: 'short' })}; earlier days show deadlines only. Markers: ◆ high risk, ▲ medium, ● low.</p>
            </div>

            <aside className="cal-panel" aria-live="polite" aria-label="Selected day">
              <h3>{label(selected.date, { weekday: 'long', day: 'numeric', month: 'long' })}{selected.date === today && <span className="cal-today-tag">Today</span>}</h3>
              {selected.plan?.capacityMinutes === 0 && <p className="cal-note">A day off.</p>}
              {selected.plan === null && <p className="cal-note">{selected.date < today ? 'This day has passed, so no preparation is scheduled.' : 'The schedule does not reach this far ahead yet.'}</p>}
              {selected.plan && selected.plan.capacityMinutes > 0 && <p className="cal-note">{formatMinutes(selected.plan.plannedMinutes)} planned of {formatMinutes(selected.plan.capacityMinutes)}{selected.plan.plannedMinutes >= selected.plan.capacityMinutes && ' · fully booked'}</p>}
              <h4>Deadlines</h4>
              {selected.deadlines.length ? (
                <ul className="cal-list">{selected.deadlines.map((o) => (
                  <li key={o.id} className={`cal-item cal-item-${tone(o)}`}>
                    <div><strong>{o.customerName}{isDemoOrder(o) && <span className="demo-tag">Demo</span>}</strong><span>{o.item}{o.quantity > 1 ? ` × ${o.quantity}` : ''}</span></div>
                    <div className="cal-item-meta"><b>Due {formatTimeInTz(o.deadline, tz)}</b>{o.prepTimeMinutes != null && <span>{formatMinutes(o.prepTimeMinutes)} prep</span>}</div>
                    <div className="cal-item-badges"><StatusBadge status={o.status} />{OPEN.includes(o.status) && <RiskBadge risk={o.risk} />}<Link to={`/orders?edit=${o.id}`} className="cal-open">Open <ArrowRight size={13} aria-hidden="true" /></Link></div>
                  </li>
                ))}</ul>
              ) : <p className="muted">No deadlines.</p>}
              <h4>Preparation</h4>
              {selected.prep.length ? (
                <ul className="cal-list">{selected.prep.map((p) => { const o = byId[p.id]; return (
                  <li key={p.id} className={`cal-item cal-item-${tone(o)} cal-item-prep`}>
                    <div><strong>{o.customerName}</strong><span>{o.item}</span></div>
                    <div className="cal-item-meta"><b>{formatMinutes(p.scheduledMinutes)}</b><span>{formatTimeInTz(p.start, tz)} – {formatTimeInTz(p.end, tz)}</span></div>
                  </li>); })}</ul>
              ) : <p className="muted">{selected.plan?.capacityMinutes === 0 ? 'Nothing scheduled on a day off.' : selected.plan ? 'Nothing scheduled.' : 'No preparation data for this day.'}</p>}
            </aside>
          </div>

          {needs.length > 0 && (
            <div className="cal-needs">
              <h3>Needs scheduling</h3>
              <p className="muted">These open orders are missing something the scheduler needs, so no date has been invented for them.</p>
              <ul className="cal-need-list">{needs.map(({ order: o, reason }) => (
                <li key={o.id}><div><strong>{o.customerName}</strong><span>{o.item}</span></div><span className="cal-need-why">Missing {MISSING[reason]}</span><Link to={`/orders?edit=${o.id}`} className="btn btn-sm">Complete order <ArrowRight size={13} aria-hidden="true" /></Link></li>
              ))}</ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
