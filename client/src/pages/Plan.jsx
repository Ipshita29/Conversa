import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, ChevronDown, ChevronLeft, ChevronRight, FlaskConical, Pencil } from 'lucide-react';
import useWorkspace from '../hooks/useWorkspace.js';
import useAsync from '../hooks/useAsync.js';
import { getConversations, updateOrder } from '../services/api.js';
import StateMessage from '../components/StateMessage.jsx';
import DemoBadge from '../components/DemoBadge.jsx';
import { summarise } from '../utils/homeSummary.js';
import { ORDER_STATUSES } from '../utils/validateOrder.js';
import { dateKey, formatDayInTz, formatInTz, formatMinutes, fromLocalInput, isDemoOrder, OPEN, STATUS_LABEL } from '../utils/format.js';
import '../css/Plan.css';

const plural = (n, one, many) => (n === 1 ? one : many);
const MISSING = { missing_prep_time: 'preparation time', missing_deadline: 'deadline', missing_both: 'preparation time and deadline' };
const LABEL = { overdue: 'Overdue', late: 'At risk', tight: 'At risk', ok: 'On track', details: 'Needs details' };

// "Today · 4:00 PM", "Tomorrow · 12:00 PM", "Yesterday · 4:00 PM", otherwise "Sat 24 Oct · 12:00 PM".
function dueLabel(iso, tz, today) {
  if (!iso) return 'No deadline';
  const day = dateKey(iso, tz);
  const diff = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  const name = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso));
  return `${name} · ${time}`;
}

function MissingRow({ order, reason, onSaved }) {
  const needsPrep = reason !== 'missing_deadline';
  const needsDeadline = reason !== 'missing_prep_time';
  const [prep, setPrep] = useState('');
  const [deadline, setDeadline] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const ready = (!needsPrep || (prep !== '' && Number(prep) >= 0)) && (!needsDeadline || deadline);
  async function save(e) {
    e.preventDefault(); setBusy(true); setErr(null);
    const patch = {};
    if (needsPrep) patch.prepTimeMinutes = Number(prep);
    if (needsDeadline) patch.deadline = fromLocalInput(deadline);
    try { await updateOrder(order.id, patch); onSaved(); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  }
  return (
    <li className="pl-missing-item">
      <div className="pl-who"><strong>{order.customerName}</strong><span>{order.item}{order.quantity > 1 ? ` × ${order.quantity}` : ''} · missing {MISSING[reason]}</span></div>
      <form className="pl-mini" onSubmit={save}>
        {needsPrep && <label>Prep time (minutes)<input type="number" min="0" step="5" value={prep} onChange={(e) => setPrep(e.target.value)} placeholder="e.g. 180" /></label>}
        {needsDeadline && <label>Deadline<input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} /></label>}
        <button type="submit" className="btn btn-sm btn-primary" disabled={!ready || busy}>{busy ? 'Saving…' : 'Save'}</button>
        <Link className="pl-link" to={`/orders?edit=${order.id}`}>Open full editor</Link>
      </form>
      {err && <p className="notice error" role="alert">{err}</p>}
    </li>
  );
}




export default function Plan() {
  const { status, data, error, reload } = useWorkspace();
  const conv = useAsync(getConversations); // optional: only to link an order to its chat
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [day, setDay] = useState('all');   // 'all' or the date (YYYY-MM-DD) orders are due
  const [openId, setOpenId] = useState(params.get('focus') === 'missing' ? 'missing' : null);
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [showDone, setShowDone] = useState(false);

  const model = useMemo(() => {
    if (!data) return null;
    const { planner, orders } = data;
    const sum = summarise({ planner, orders });
    const move = Object.fromEntries((planner.nextMoves ?? []).map((m) => [m.orderId, m]));
    // One list. The scheduler's classification sets the rank; inside a rank the most urgent comes first.
    //   0 overdue, 1 predicted late / cannot fit, 2 thin buffer, 3 on track, 4 missing details (always last)
    const rank = (e) => (e.kind === 'deadline_passed' ? 0 : e.kind === 'late' || e.kind === 'unschedulable' ? 1 : e.kind === 'tight' ? 2 : 3);
    const scheduled = planner.schedule.filter((e) => sum.byId[e.orderId]).map((e) => ({ id: e.orderId, e, o: sum.byId[e.orderId], rank: rank(e) }))
      .sort((a, b) => a.rank - b.rank || (a.rank === 2 ? a.e.bufferMinutes - b.e.bufferMinutes : 0) || Date.parse(a.o.deadline) - Date.parse(b.o.deadline));
    const missing = planner.unscheduledOrders.filter((u) => sum.byId[u.id]).map((u) => ({ id: u.id, u, o: sum.byId[u.id], rank: 4 }))
      .sort((a, b) => (a.o.deadline ? Date.parse(a.o.deadline) : Infinity) - (b.o.deadline ? Date.parse(b.o.deadline) : Infinity));
    return { planner, orders, sum, move, rows: [...scheduled, ...missing] };
  }, [data]);

  const head = (nav, sub) => (
    <header className="pq-head">
      <div className="pq-head-row"><h1>Production plan</h1><div className="pq-head-side">{nav}<DemoBadge /></div></div>
      {sub && <p className="pq-count">{sub}</p>}
    </header>
  );
  if (status === 'loading' && !data) return <section className="page plan">{head()}<StateMessage kind="loading" message="Building your plan…" /></section>;
  if (status === 'error') return <section className="page plan">{head()}<StateMessage kind="error" message={`Couldn't load your plan. ${error.message}`} onRetry={reload} /></section>;

  const { planner, orders, sum, move, rows } = model;
  const { tz, today, riskIds } = sum;
  const done = orders.filter((o) => o.status === 'completed');
  const convByOrder = Object.fromEntries((conv.data?.items ?? []).filter((c) => c.orderId).map((c) => [c.orderId, c.id]));
  const dueDates = [...new Set(rows.filter((r) => r.o.deadline).map((r) => dateKey(r.o.deadline, tz)))].sort();
  const navList = ['all', ...dueDates];
  const navIdx = Math.max(0, navList.indexOf(day));
  const shown = day === 'all' ? rows : rows.filter((r) => r.o.deadline && dateKey(r.o.deadline, tz) === day);
  const open = sum.open.length;
  const sub = `${open} open ${plural(open, 'order', 'orders')} · ${riskIds.size} at risk`;
  const simulate = (o, e) => navigate('/whatif', { state: { prefill: { orderId: o.id, deadline: e?.suggestedDeadline ?? o.deadline, nonce: Date.now() } } });

  async function setStatus(o, next) {
    setBusy(o.id); setActionError(null);
    try { await updateOrder(o.id, { status: next }); reload(); }
    catch (e) { setActionError(`Couldn't update ${o.customerName}'s order: ${e.message}`); }
    finally { setBusy(null); }
  }

  const nav = dueDates.length > 0 && (
    <div className="pq-daynav" role="group" aria-label="Choose a day">
      <button type="button" onClick={() => setDay(navList[navIdx - 1])} disabled={navIdx === 0} aria-label="Previous day"><ChevronLeft size={16} aria-hidden="true" /></button>
      <span aria-live="polite">{day === 'all' ? 'All days' : day === today ? 'Due today' : `Due ${formatDayInTz(day)}`}</span>
      <button type="button" onClick={() => setDay(navList[navIdx + 1])} disabled={navIdx >= navList.length - 1} aria-label="Next day"><ChevronRight size={16} aria-hidden="true" /></button>
    </div>
  );

  const renderRow = (r) => {
    const { o, e, u, rank } = r;
    const kind = rank === 0 ? 'overdue' : rank <= 2 ? (rank === 1 ? 'late' : 'tight') : rank === 3 ? 'ok' : 'details';
    const tone = rank <= 1 ? 'red' : rank === 2 ? 'amber' : rank === 4 ? 'blue' : 'plain';
    const isOpen = openId === o.id || (rank === 4 && openId === 'missing');
    const m = move[o.id];
    const chatId = convByOrder[o.id];
    const why = !e ? null : e.kind === 'deadline_passed' ? `Deadline passed by ${formatMinutes(Math.max(1, Math.round((Date.parse(planner.generatedAt) - Date.parse(o.deadline)) / 60000)))}.`
      : e.kind === 'late' ? `Estimated to finish ${formatMinutes(e.shortfallMinutes)} after the deadline.`
        : e.kind === 'unschedulable' ? `Cannot be scheduled within the next ${planner.rules?.horizonDays ?? 60} days of working capacity.`
          : `Estimated to finish ${formatMinutes(e.bufferMinutes)} before the deadline.`;
    return (
      <li key={o.id} className={`pq-item is-${tone}${isOpen ? ' is-open' : ''}`}>
        <button type="button" className="pq-row" aria-expanded={isOpen} onClick={() => setOpenId(isOpen ? null : o.id)}>
          <span className="pq-who">{o.customerName}{isDemoOrder(o) && <span className="demo-tag">Demo</span>}</span>
          <span className="pq-what">{o.item}{o.quantity > 1 ? ` × ${o.quantity}` : ''}</span>
          <span className="pq-flag">{LABEL[kind]}</span>
          <span className="pq-due">{o.deadline ? dueLabel(o.deadline, tz, today) : 'No deadline'}</span>
          <ChevronDown size={15} className="pq-chev" aria-hidden="true" />
        </button>
        {isOpen && (rank === 4 ? (
          <div className="pq-detail"><p className="pq-why">Missing {MISSING[u.reason]}, so this order can't be scheduled yet.</p><ul className="pq-missing"><MissingRow order={o} reason={u.reason} onSaved={reload} /></ul></div>
        ) : (
          <div className="pq-detail">
            <p className="pq-why">{why}</p>
            <dl>
              <div><dt>Status</dt><dd>{STATUS_LABEL[o.status]}</dd></div>
              <div><dt>Promised deadline</dt><dd>{formatInTz(o.deadline, tz)}</dd></div>
              <div><dt>{rank === 0 ? 'Earliest possible finish' : 'Predicted finish'}</dt><dd>{e.scheduledEnd ? formatInTz(e.scheduledEnd, tz) : 'Not within the planning horizon'}</dd></div>
              <div><dt>Preparation</dt><dd>{formatMinutes(o.prepTimeMinutes)}, starting {formatInTz(e.scheduledStart, tz)}</dd></div>
            </dl>
            {m && m.kind !== 'on_track' && <p className="pq-rec"><b>Recommended:</b> {m.recovery ?? m.action}{e.suggestedDeadline ? ` Suggested new deadline: ${formatInTz(e.suggestedDeadline, tz)}.` : ''}</p>}
            {o.notes && !isDemoOrder(o) && <p className="pq-rec"><b>Notes:</b> {o.notes}</p>}
            <div className="pq-actions">
              <Link className="btn btn-sm" to={`/orders?edit=${o.id}`}><Pencil size={13} aria-hidden="true" /> Open order</Link>
              {chatId && <Link className="btn btn-sm" to={`/inbox?conversation=${chatId}`}>Open conversation</Link>}
              <button type="button" className="btn btn-sm" onClick={() => simulate(o, e)}><FlaskConical size={13} aria-hidden="true" /> Simulate a change</button>
              <label className="pq-status"><span>Status</span>
                <select value={o.status} disabled={busy === o.id} onChange={(ev) => setStatus(o, ev.target.value)} aria-label={`Status for ${o.customerName}`}>
                  {ORDER_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                </select></label>
            </div>
          </div>
        ))}
      </li>
    );
  };

  if (rows.length === 0 && done.length === 0) return <section className="page plan">{head(null)}<StateMessage message="No orders yet. Add one from Orders, or draft one from a customer message." /></section>;

  return (
    <section className="page plan">
      {head(nav, sub)}
      {actionError && <div className="notice error" role="alert">{actionError}</div>}
      {shown.length > 0 ? <ul className="pq-list">{shown.map(renderRow)}</ul>
        : <p className="pq-empty">{rows.length === 0 ? 'No open orders right now.' : 'No order is due on this day.'}</p>}

      {done.length > 0 && (
        <div className="pq-done">
          <button type="button" className="pq-donebar" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}><span>Completed orders ({done.length})</span><ChevronDown size={15} className="pq-chev" aria-hidden="true" /></button>
          {showDone && <ul className="pq-done-list">{done.map((o) => <li key={o.id}><strong>{o.customerName}</strong><span>{o.item}{o.quantity > 1 ? ` × ${o.quantity}` : ''}</span></li>)}</ul>}
        </div>
      )}
      <p className="pq-foot"><Link to="/risks">Full risk breakdown <ArrowRight size={12} aria-hidden="true" /></Link></p>
    </section>
  );
}
