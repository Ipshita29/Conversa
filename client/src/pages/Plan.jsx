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




const COLUMNS = [
  { key: 'critical', title: 'Critical', hint: 'Overdue or predicted late' },
  { key: 'upcoming', title: 'Upcoming', hint: 'Nearest deadline first' },
  { key: 'details', title: 'Needs details', hint: "Can't be scheduled yet" },
  { key: 'done', title: 'Completed', hint: '' },
];

export default function Plan() {
  const { status, data, error, reload } = useWorkspace();
  const conv = useAsync(getConversations); // optional: only to link an order to its chat
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [day, setDay] = useState('all');   // 'all' or the date (YYYY-MM-DD) orders are due
  const [openId, setOpenId] = useState(params.get('focus') === 'missing' ? 'missing' : null);
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);

  const model = useMemo(() => {
    if (!data) return null;
    const { planner, orders } = data;
    const sum = summarise({ planner, orders });
    const move = Object.fromEntries((planner.nextMoves ?? []).map((m) => [m.orderId, m]));
    const ms = (o) => (o.deadline ? Date.parse(o.deadline) : Infinity);
    // The column comes from the scheduler's classification and the order's status. Cards cannot be dragged: a manual move must never
    // override a risk calculation, so the only way an order changes column is a real change to the order (status, deadline, prep time).
    const items = planner.schedule.filter((e) => sum.byId[e.orderId]).map((e) => ({ id: e.orderId, e, o: sum.byId[e.orderId] }));
    const critical = items.filter((x) => x.e.risk === 'high')
      .sort((a, b) => (b.e.kind === 'deadline_passed') - (a.e.kind === 'deadline_passed') || ms(a.o) - ms(b.o));
    const upcoming = items.filter((x) => x.e.risk !== 'high').sort((a, b) => ms(a.o) - ms(b.o));
    const details = planner.unscheduledOrders.filter((u) => sum.byId[u.id]).map((u) => ({ id: u.id, u, o: sum.byId[u.id] })).sort((a, b) => ms(a.o) - ms(b.o));
    const done = orders.filter((o) => o.status === 'completed').map((o) => ({ id: o.id, o })).sort((a, b) => ms(b.o) - ms(a.o));
    return { planner, orders, sum, move, cols: { critical, upcoming, details, done } };
  }, [data]);

  const head = (nav, sub) => (
    <header className="kb-head">
      <div><h1>Production board</h1><p>Every order, by what it needs from you.{sub && <b>{sub}</b>}</p></div>
      <div className="kb-head-side">{nav}<DemoBadge /></div>
    </header>
  );
  if (status === 'loading' && !data) return <section className="page plan">{head()}<StateMessage kind="loading" message="Building your board…" /></section>;
  if (status === 'error') return <section className="page plan">{head()}<StateMessage kind="error" message={`Couldn't load your board. ${error.message}`} onRetry={reload} /></section>;

  const { planner, orders, sum, move, cols } = model;
  const { tz, today } = sum;
  const convByOrder = Object.fromEntries((conv.data?.items ?? []).filter((c) => c.orderId).map((c) => [c.orderId, c.id]));
  const dueDates = [...new Set([...cols.critical, ...cols.upcoming, ...cols.details].filter((x) => x.o.deadline).map((x) => dateKey(x.o.deadline, tz)))].sort();
  const navList = ['all', ...dueDates];
  const navIdx = Math.max(0, navList.indexOf(day));
  const inDay = (x) => day === 'all' || (x.o.deadline && dateKey(x.o.deadline, tz) === day);
  const open = sum.open.length;
  const sub = ` ${open} open ${plural(open, 'order', 'orders')}`;
  const simulate = (o, e) => navigate('/whatif', { state: { prefill: { orderId: o.id, deadline: e?.suggestedDeadline ?? o.deadline, nonce: Date.now() } } });

  async function setStatus(o, next) {
    setBusy(o.id); setActionError(null);
    try { await updateOrder(o.id, { status: next }); reload(); }
    catch (e) { setActionError(`Couldn't update ${o.customerName}'s order: ${e.message}`); }
    finally { setBusy(null); }
  }

  const nav = dueDates.length > 0 && (
    <div className="pq-daynav" role="group" aria-label="Filter by deadline day">
      <button type="button" onClick={() => setDay(navList[navIdx - 1])} disabled={navIdx === 0} aria-label="Previous day"><ChevronLeft size={16} aria-hidden="true" /></button>
      <span aria-live="polite">{day === 'all' ? 'All days' : day === today ? 'Due today' : `Due ${formatDayInTz(day)}`}</span>
      <button type="button" onClick={() => setDay(navList[navIdx + 1])} disabled={navIdx >= navList.length - 1} aria-label="Next day"><ChevronRight size={16} aria-hidden="true" /></button>
    </div>
  );

  const indicator = (col, x) => {
    if (col === 'done') return ['Completed', 'green'];
    if (col === 'details') return [`Missing ${MISSING[x.u.reason]}`, 'blue'];
    if (col === 'critical') return [x.e.kind === 'deadline_passed' ? 'Overdue' : x.e.kind === 'unschedulable' ? 'Cannot fit' : 'Predicted late', 'red'];
    return x.e.risk === 'medium' ? ['Thin buffer', 'amber'] : ['On track', 'plain'];
  };

  const renderCard = (col, x) => {
    const { o, e, u } = x;
    const isOpen = openId === o.id || (col === 'details' && openId === 'missing');
    const [label, tone] = indicator(col, x);
    const m = move[o.id];
    const chatId = convByOrder[o.id];
    const why = !e ? null : e.kind === 'deadline_passed' ? `Deadline passed by ${formatMinutes(Math.max(1, Math.round((Date.parse(planner.generatedAt) - Date.parse(o.deadline)) / 60000)))}.`
      : e.kind === 'late' ? `Estimated to finish ${formatMinutes(e.shortfallMinutes)} after the deadline.`
        : e.kind === 'unschedulable' ? `Cannot be scheduled within the next ${planner.rules?.horizonDays ?? 60} days of working capacity.`
          : `Estimated to finish ${formatMinutes(e.bufferMinutes)} before the deadline.`;
    return (
      <li key={o.id} className={`kb-card is-${col}${col === 'upcoming' && tone === 'amber' ? ' is-thin' : ''}${isOpen ? ' is-open' : ''}`}>
        <button type="button" className="kb-main" aria-expanded={isOpen} onClick={() => setOpenId(isOpen ? null : o.id)}>
          <span className="kb-who">{o.customerName}{isDemoOrder(o) && <span className="demo-tag">Demo</span>}</span>
          <span className="kb-what">{o.item}{o.quantity > 1 ? ` × ${o.quantity}` : ''}</span>
          <span className="kb-meta"><span className={`kb-due${col === 'critical' ? ' is-late' : ''}`}>{o.deadline ? dueLabel(o.deadline, tz, today) : 'No deadline'}</span><span className={`kb-flag is-${tone}`}>{label}</span></span>
        </button>
        {isOpen && (col === 'details' ? (
          <div className="kb-detail"><ul className="pq-missing"><MissingRow order={o} reason={u.reason} onSaved={reload} /></ul></div>
        ) : (
          <div className="kb-detail">
            {col !== 'done' && why && <p className="kb-why">{why}</p>}
            <dl>
              <div><dt>Status</dt><dd>{STATUS_LABEL[o.status]}</dd></div>
              <div><dt>Promised deadline</dt><dd>{formatInTz(o.deadline, tz)}</dd></div>
              {e && <div><dt>{e.kind === 'deadline_passed' ? 'Earliest finish' : 'Predicted finish'}</dt><dd>{e.scheduledEnd ? formatInTz(e.scheduledEnd, tz) : 'Not within the planning horizon'}</dd></div>}
              <div><dt>Preparation</dt><dd>{formatMinutes(o.prepTimeMinutes)}{e && <>, starting {formatInTz(e.scheduledStart, tz)}</>}</dd></div>
            </dl>
            {col !== 'done' && m && m.kind !== 'on_track' && <p className="kb-rec"><b>Recommended:</b> {m.recovery ?? m.action}{e?.suggestedDeadline ? ` Suggested new deadline: ${formatInTz(e.suggestedDeadline, tz)}.` : ''}</p>}
            {o.notes && !isDemoOrder(o) && <p className="kb-rec"><b>Notes:</b> {o.notes}</p>}
            <div className="kb-actions">
              <Link className="btn btn-sm" to={`/orders?edit=${o.id}`}><Pencil size={13} aria-hidden="true" /> Open order</Link>
              {chatId && <Link className="btn btn-sm" to={`/inbox?conversation=${chatId}`}>Conversation</Link>}
              {col !== 'done' && <button type="button" className="btn btn-sm" onClick={() => simulate(o, e)}><FlaskConical size={13} aria-hidden="true" /> Simulate</button>}
              <label className="kb-status"><span>Status</span>
                <select value={o.status} disabled={busy === o.id} onChange={(ev) => setStatus(o, ev.target.value)} aria-label={`Status for ${o.customerName}`}>
                  {ORDER_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                </select></label>
            </div>
          </div>
        ))}
      </li>
    );
  };

  if (orders.length === 0) return <section className="page plan">{head(null, null)}<StateMessage message="No orders yet. Add one from Orders, or draft one from a customer message." /></section>;

  return (
    <section className="page plan">
      {head(nav, sub)}
      {actionError && <div className="notice error" role="alert">{actionError}</div>}
      <div className="kb-board" role="list">
        {COLUMNS.map((c) => {
          const list = c.key === 'done' ? cols.done : cols[c.key].filter(inDay);
          return (
            <section key={c.key} className={`kb-col is-${c.key}`} aria-label={`${c.title}, ${list.length} ${plural(list.length, 'order', 'orders')}`} role="listitem">
              <header className="kb-col-head"><h2>{c.title}</h2><b>{list.length}</b>{c.hint && <span>{c.hint}</span>}</header>
              {list.length === 0 ? <p className="kb-none">{day !== 'all' && c.key !== 'done' ? 'None due this day' : 'None'}</p> : <ul className="kb-cards">{list.map((x) => renderCard(c.key, x))}</ul>}
            </section>
          );
        })}
      </div>
      <p className="pq-foot"><Link to="/risks">Full risk breakdown <ArrowRight size={12} aria-hidden="true" /></Link></p>
    </section>
  );
}
