import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import useAsync from '../hooks/useAsync.js';
import { getBoard, getPlanner, listOrders } from '../services/api.js';
import { DemoBadge, StateMessage } from '../components/UI.jsx';
import { GapRow, RushModal, TaskRow } from '../components/Roadmap.jsx';
import { buildDay } from '../utils/roadmap.js';
import { formatDayInTz, formatMinutes, formatTimeInTz } from '../utils/format.js';
import '../css/Plan.css';


const plural = (n, one, many) => (n === 1 ? one : many);
const SKIP_KEY = 'conversa.plan.skipped';
const readSkipped = () => { try { return JSON.parse(localStorage.getItem(SKIP_KEY)) ?? []; } catch { return []; } };

// The production roadmap. Every time on this page comes from the scheduler (GET /api/planner): work is placed earliest-deadline-first,
// and whatever capacity is left is the "available capacity" shown on the timeline. Nothing is hardcoded and nothing is saved by looking.
export default function Plan() {
  const navigate = useNavigate();
  const { status, data, error, reload } = useAsync(async () => {
    const [planner, board, orders] = await Promise.all([getPlanner({ days: 30 }), getBoard('all'), listOrders({ pageSize: 100 })]);
    return { planner, board, orders: orders.items };
  });
  const [picked, setPicked] = useState(null);
  const [rushFor, setRushFor] = useState(null); // the free slot a rush order is being checked for
  const [skipped, setSkipped] = useState(readSkipped);
  const [notice, setNotice] = useState(null);
  useEffect(() => { try { localStorage.setItem(SKIP_KEY, JSON.stringify(skipped.slice(-60))); } catch { /* private mode */ } }, [skipped]);

  const planner = data?.planner;
  const tz = planner?.range.timezone;
  const days = planner?.days ?? [];
  const firstBusy = days.find((d) => d.orders.length > 0) ?? days.find((d) => d.capacityMinutes > 0) ?? days[0];
  const date = picked && days.some((d) => d.date === picked) ? picked : firstBusy?.date;
  const idx = days.findIndex((d) => d.date === date);

  const board = useMemo(() => (data ? [...data.board.sections.overdue, ...data.board.sections.onTrack, ...data.board.sections.upcoming] : []), [data]);
  const day = useMemo(() => (data ? buildDay(days[idx], { schedule: planner.schedule, board, orders: data.orders }) : null), [data, idx]); // eslint-disable-line react-hooks/exhaustive-deps
  // The nearest free slot big enough for a rush order, across the whole horizon (skipped slots left out).
  const nextOpen = useMemo(() => {
    if (!data) return null;
    for (const d of days) {
      const g = buildDay(d, { schedule: planner.schedule, board, orders: data.orders }).rows.find((r) => r.type === 'gap' && r.canRush && !skipped.includes(r.key));
      if (g) return { date: d.date, gap: g };
    }
    return null;
  }, [data, skipped]); // eslint-disable-line react-hooks/exhaustive-deps
  const skip = (k) => setSkipped((s) => [...s, k]);

  const head = (
    <header className="rm-head">
      <div className="rm-title">
        <h1>Production roadmap</h1>
        <p className="rm-sub">What to make next, and where there is room for more.</p>
        {day && <p className="rm-pulse"><b>{day.rows.filter((r) => r.type === 'task').length}</b> {plural(day.rows.filter((r) => r.type === 'task').length, 'task', 'tasks')} · <b>{formatMinutes(day.booked)}</b> booked · <b className="is-free">{formatMinutes(day.free)}</b> free</p>}
      </div>
      <div className="rm-head-actions">
        <DemoBadge />
        {days.length > 0 && (
          <div className="rm-date" role="group" aria-label="Choose a day">
            <button type="button" onClick={() => setPicked(days[idx - 1].date)} disabled={idx <= 0} aria-label="Previous day"><ChevronLeft size={16} aria-hidden="true" /></button>
            <label><span className="sr-only">Day</span>
              <input type="date" value={date} min={days[0].date} max={days[days.length - 1].date} onChange={(e) => e.target.value && days.some((d) => d.date === e.target.value) && setPicked(e.target.value)} />
            </label>
            <button type="button" onClick={() => setPicked(days[idx + 1].date)} disabled={idx >= days.length - 1} aria-label="Next day"><ChevronRight size={16} aria-hidden="true" /></button>
            {date !== days[0].date && <button type="button" className="rm-today" onClick={() => setPicked(days[0].date)}>Today</button>}
          </div>
        )}
      </div>
    </header>
  );

  if (!data && status === 'loading') return <section className="page plan roadmap">{head}<StateMessage kind="loading" message="Building your roadmap…" /></section>;
  if (status === 'error' || !data) return <section className="page plan roadmap">{head}<StateMessage kind="error" message={`Couldn't load the plan. ${error?.message ?? ''}`} onRetry={reload} /></section>;

  const tasks = day.rows.filter((r) => r.type === 'task');
  const firstTask = tasks[0]?.key;
  const needs = data.board.needsDetails;
  const pct = (m) => (day.capacity ? Math.min(100, (m / day.capacity) * 100) : 0);
  const counts = { overdue: 0, onTrack: 0, upcoming: 0 };
  tasks.forEach((t) => { counts[t.section] += 1; });

  return (
    <section className={`page plan roadmap${status === 'loading' ? ' is-loading' : ''}`}>
      {head}
      {notice && <div className="notice info rm-notice" role="status">{notice} <button type="button" onClick={() => setNotice(null)}>Dismiss</button></div>}

      <div className="rm-layout">
        <div className="rm-main">
          <h2 className="rm-day">{formatDayInTz(date)}</h2>
          {day.capacity === 0 ? (
            <StateMessage message={idx === 0 ? 'No production time is left today.' : 'This is not a working day.'}>
              <button type="button" className="btn btn-primary" onClick={() => firstBusy && setPicked(firstBusy.date)}>Jump to the next busy day</button>
            </StateMessage>
          ) : (
            <ol className="rm-line">
              {day.rows.map((r) => (r.type === 'task'
                ? <TaskRow key={r.key} row={r} tz={tz} next={r.key === firstTask && idx === days.findIndex((d) => d.orders.length > 0)} onWhatIf={(row) => navigate('/whatif', { state: { prefill: { orderId: row.id, deadline: row.deadline, nonce: Date.now() } } })} />
                : <GapRow key={r.key} gap={r} tz={tz} skipped={skipped.includes(r.key)} onRush={() => setRushFor(r)} onSkip={() => skip(r.key)} onRestore={() => setSkipped((s) => s.filter((k) => k !== r.key))} />))}
            </ol>
          )}
          {needs.length > 0 && (
            <p className="rm-needs">
              {needs.length} {plural(needs.length, 'order has', 'orders have')} no preparation time or deadline yet, so {plural(needs.length, 'it is', 'they are')} not on the timeline:{' '}
              {needs.map((n, i) => <span key={n.id}>{i > 0 && ', '}<Link to={`/orders?edit=${n.id}`}>{n.customerName}</Link></span>)}.
            </p>
          )}
        </div>

        <aside className="rm-side" aria-label="Day summary">
          <section className="rm-panel">
            <h2>Capacity</h2>
            <div className="rm-bar" role="img" aria-label={`${formatMinutes(day.booked)} booked, ${formatMinutes(day.free)} free`}>
              <i className="is-booked" style={{ width: `${pct(day.booked)}%` }} /><i className="is-free" style={{ width: `${pct(day.free)}%` }} />
            </div>
            <ul className="rm-legend"><li><i className="is-booked" />Booked production <b>{formatMinutes(day.booked)}</b></li><li><i className="is-free" />Available buffer <b>{formatMinutes(day.free)}</b></li></ul>
          </section>
          {nextOpen && (
            <section className="rm-panel rm-open">
              <h2>Next opening</h2>
              <p className="rm-open-slot">{formatDayInTz(nextOpen.date)}<br />{formatTimeInTz(nextOpen.gap.start, tz)} – {formatTimeInTz(nextOpen.gap.end, tz)} · {formatMinutes(nextOpen.gap.minutes)} free</p>
              {nextOpen.date !== date && <button type="button" className="btn" onClick={() => setPicked(nextOpen.date)}>Show this day</button>}
            </section>
          )}
          <section className="rm-panel">
            <h2>Status</h2>
            <ul className="rm-counts">
              <li><em className="rm-status is-overdue">Overdue</em><b>{counts.overdue}</b></li>
              <li><em className="rm-status is-upcoming">Upcoming</em><b>{counts.upcoming}</b></li>
              <li><em className="rm-status is-ontrack">On track</em><b>{counts.onTrack}</b></li>
            </ul>
          </section>
          <p className="rm-side-note">Want to try a bigger change? <Link to="/whatif">Open What-if</Link> · <Link to="/risks">Risk breakdown</Link></p>
        </aside>
      </div>

      {rushFor && <RushModal gap={rushFor} tz={tz} orders={data.orders} onClose={() => setRushFor(null)}
        onAccepted={(o) => { setRushFor(null); setNotice(`Rush order for ${o.customerName} added. The timeline has been recalculated.`); reload(); }} />}
    </section>
  );
}
