import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, ChevronDown, FlaskConical, Pencil, X } from 'lucide-react';
import useWorkspace from '../hooks/useWorkspace.js';
import { updateOrder } from '../services/api.js';
import StateMessage from '../components/StateMessage.jsx';
import DemoBadge from '../components/DemoBadge.jsx';
import { formatDayInTz, formatInTz, formatMinutes, formatTimeInTz, fromLocalInput, isDemoOrder, OPEN } from '../utils/format.js';
import '../css/Plan.css';

const plural = (n, one, many) => (n === 1 ? one : many);
const UPCOMING_PREVIEW = 3;
const MISSING = { missing_prep_time: 'preparation time', missing_deadline: 'deadline', missing_both: 'preparation time and deadline' };

// One row per order. The scheduler may split a long job across days; the row sits at the order's first start and always quotes the
// scheduler's own predicted finish (entry.scheduledEnd), so every figure on this page comes from the same place.
function badgeFor(entry, order) {
  if (order.status === 'completed') return ['done', 'Completed'];
  if (entry?.kind === 'deadline_passed') return ['late', 'Overdue'];
  if (entry?.risk === 'high') return ['late', 'At risk'];
  if (entry?.risk === 'medium') return ['tight', 'Tight'];
  return ['plain', order.status === 'in_progress' ? 'In progress' : 'On track'];
}

function slack(entry) {
  if (!entry) return null;
  if (entry.kind === 'deadline_passed') return { text: 'The deadline has already passed.', tone: 'late' };
  if (entry.scheduledEnd === null) return { text: 'Cannot be scheduled within the planning horizon.', tone: 'late' };
  if (entry.bufferMinutes < 0) return { text: `Finishes ${formatMinutes(-entry.bufferMinutes)} after the deadline.`, tone: 'late' };
  return { text: `Finishes ${formatMinutes(entry.bufferMinutes)} before the deadline.`, tone: entry.risk === 'medium' ? 'tight' : 'ok' };
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
  const navigate = useNavigate();
  const [onlyRisk, setOnlyRisk] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [allUpcoming, setAllUpcoming] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [showMissing, setShowMissing] = useState(false);

  const view = useMemo(() => {
    if (!data) return null;
    const { planner, orders } = data;
    const byId = Object.fromEntries(orders.map((o) => [o.id, o]));
    const entry = Object.fromEntries(planner.schedule.map((e) => [e.orderId, e]));
    const move = Object.fromEntries((planner.nextMoves ?? []).map((m) => [m.orderId, m]));
    // First block of each order, across all days: that is where the order sits in the list.
    const first = new Map();
    for (const d of planner.days) for (const b of d.orders) if (byId[b.id] && !first.has(b.id)) first.set(b.id, { ...b, date: d.date, blocks: 0 });
    for (const d of planner.days) for (const b of d.orders) if (first.has(b.id)) first.get(b.id).blocks += 1;
    const rows = [...first.values()].sort((a, b) => new Date(a.start) - new Date(b.start));
    return { planner, orders, byId, entry, move, rows };
  }, [data]);

  const head = (sub) => (
    <header className="pl-head">
      <div><h1>Today's plan</h1>{sub && <p>{sub}</p>}</div>
      <DemoBadge />
    </header>
  );
  if (status === 'loading' && !data) return <section className="page plan">{head()}<StateMessage kind="loading" message="Building your plan…" /></section>;
  if (status === 'error') return <section className="page plan">{head()}<StateMessage kind="error" message={`Couldn't load your plan. ${error.message}`} onRetry={reload} /></section>;

  const { planner, orders, byId, entry, move, rows } = view;
  const tz = planner.range.timezone;
  const today = planner.range.from;
  const open = orders.filter((o) => OPEN.includes(o.status));
  const blocked = planner.unscheduledOrders.filter((u) => byId[u.id]);
  const done = orders.filter((o) => o.status === 'completed');
  const atRiskIds = new Set(planner.schedule.filter((e) => e.risk !== 'low' && byId[e.orderId]).map((e) => e.orderId));
  const atRisk = atRiskIds.size;
  const visible = onlyRisk ? rows.filter((r) => atRiskIds.has(r.id)) : rows;
  const todayRows = visible.filter((r) => r.date === today);
  const upcoming = visible.filter((r) => r.date !== today);
  const shownUpcoming = allUpcoming || onlyRisk ? upcoming : upcoming.slice(0, UPCOMING_PREVIEW);
  const next = rows.find((r) => r.date === today) ?? rows[0] ?? null;
  const dateLabel = new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(planner.generatedAt));
  const sub = `${dateLabel} · ${open.length} ${plural(open.length, 'order', 'orders')}`;
  const simulate = (o, e) => navigate('/whatif', { state: { prefill: { orderId: o.id, deadline: e?.suggestedDeadline ?? o.deadline, nonce: Date.now() } } });

  const groups = [];
  shownUpcoming.forEach((r) => { const g = groups[groups.length - 1]; if (g?.date === r.date) g.items.push(r); else groups.push({ date: r.date, items: [r] }); });

  const renderRow = (r) => {
    const o = byId[r.id]; const e = entry[r.id]; const m = move[r.id];
    const [tone, label] = badgeFor(e, o);
    const isNext = next?.id === r.id && !onlyRisk;
    const isOpen = openId === r.id;
    const s = slack(e);
    const split = r.blocks > 1;
    return (
      <li key={r.id} className={`pl-item pl-${tone}${isNext ? ' is-next' : ''}${isOpen ? ' is-open' : ''}`}>
        <button type="button" className="pl-row" aria-expanded={isOpen} onClick={() => setOpenId(isOpen ? null : r.id)}>
          <span className="pl-time">{formatTimeInTz(r.start, tz)}</span>
          <span className="pl-who"><strong>{o.customerName}{isDemoOrder(o) && <span className="demo-tag">Demo</span>}{isNext && <em className="pl-next">Next</em>}</strong><span>{o.item}{o.quantity > 1 ? ` × ${o.quantity}` : ''}</span></span>
          <span className="pl-meta"><span>{formatMinutes(o.prepTimeMinutes)} prep</span><span>Due {formatInTz(o.deadline, tz)}</span></span>
          <span className={`pl-tag pl-tag-${tone}`}>{label}</span>
          <ChevronDown size={16} className="pl-chev" aria-hidden="true" />
        </button>
        {isNext && m && m.kind !== 'on_track' && !isOpen && <p className="pl-action"><b>Do next:</b> {m.action}</p>}
        {isOpen && (
          <div className="pl-detail">
            <dl>
              <div><dt>Promised deadline</dt><dd>{formatInTz(o.deadline, tz)}</dd></div>
              <div><dt>Predicted finish</dt><dd>{e?.scheduledEnd ? formatInTz(e.scheduledEnd, tz) : 'Not within the planning horizon'}{split && <small>across {r.blocks} working days</small>}</dd></div>
              <div><dt>Preparation</dt><dd>{formatMinutes(o.prepTimeMinutes)}, starting {formatInTz(r.start, tz)}</dd></div>
              {s && <div><dt>{s.tone === 'late' ? 'Delay' : 'Buffer'}</dt><dd className={`pl-slack-${s.tone}`}>{s.text}</dd></div>}
            </dl>
            {e && e.risk !== 'low' && e.kind !== 'deadline_passed' && e.kind !== 'late' && <p className="pl-why">{e.reason}</p>}
            {m && m.kind !== 'on_track' && <p className="pl-rec"><b>Recommended:</b> {m.recovery ?? m.action}{e?.suggestedDeadline ? ` Suggested new deadline: ${formatInTz(e.suggestedDeadline, tz)}.` : ''}</p>}
            <div className="pl-detail-actions">
              <Link className="btn btn-sm" to={`/orders?edit=${o.id}`}><Pencil size={13} aria-hidden="true" /> Edit order</Link>
              {OPEN.includes(o.status) && <button type="button" className="btn btn-sm" onClick={() => simulate(o, e)}><FlaskConical size={13} aria-hidden="true" /> Simulate a change</button>}
            </div>
          </div>
        )}
      </li>
    );
  };

  if (rows.length === 0 && blocked.length === 0 && done.length === 0) return <section className="page plan">{head(sub)}<StateMessage message="Nothing to schedule right now." /></section>;

  return (
    <section className="page plan">
      {head(sub)}

      {atRisk > 0 && (
        <button type="button" className={`pl-alert${onlyRisk ? ' is-on' : ''}`} aria-pressed={onlyRisk} onClick={() => { setOnlyRisk(!onlyRisk); setOpenId(null); }}>
          <AlertTriangle size={18} aria-hidden="true" />
          <span><b>{atRisk} {plural(atRisk, 'order is', 'orders are')} at risk.</b> Some orders may finish after their promised deadlines.</span>
          <span className="pl-alert-go">{onlyRisk ? <>Show all <X size={14} aria-hidden="true" /></> : 'Show them'}</span>
        </button>
      )}

      {todayRows.length > 0 && <h2 className="pl-day">{onlyRisk ? 'At risk · today' : 'Today'}</h2>}
      {todayRows.length > 0 && <ol className="pl-list">{todayRows.map(renderRow)}</ol>}
      {todayRows.length === 0 && !onlyRisk && <p className="pl-empty">Nothing is scheduled to start today.</p>}

      {groups.map((g) => (
        <div key={g.date}>
          <h2 className="pl-day">{onlyRisk ? `At risk · ${formatDayInTz(g.date)}` : formatDayInTz(g.date)}</h2>
          <ol className="pl-list">{g.items.map(renderRow)}</ol>
        </div>
      ))}
      {!onlyRisk && upcoming.length > UPCOMING_PREVIEW && (
        <button type="button" className="pl-viewall" onClick={() => setAllUpcoming(!allUpcoming)}>{allUpcoming ? 'Show fewer' : `View all upcoming (${upcoming.length})`}</button>
      )}
      {onlyRisk && visible.length === 0 && <p className="pl-empty">No scheduled order is at risk.</p>}

      {blocked.length > 0 && (
        <div className="pl-missing">
          <button type="button" className="pl-missing-head" aria-expanded={showMissing} onClick={() => setShowMissing(!showMissing)}>
            <span className="pl-dot" aria-hidden="true" /><b>{blocked.length} {plural(blocked.length, 'order needs', 'orders need')} details</b><span>to be scheduled</span><ChevronDown size={16} className="pl-chev" aria-hidden="true" />
          </button>
          {showMissing && <ul className="pl-missing-list">{blocked.map((u) => <MissingRow key={u.id} order={byId[u.id]} reason={u.reason} onSaved={reload} />)}</ul>}
        </div>
      )}

      {done.length > 0 && (
        <div className="pl-done">
          <button type="button" className="pl-viewall" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>{showDone ? 'Hide completed' : `Completed (${done.length})`}</button>
          {showDone && <ul className="pl-done-list">{done.map((o) => <li key={o.id}><span className="pl-tag pl-tag-done">Completed</span><strong>{o.customerName}</strong><span>{o.item}</span></li>)}</ul>}
        </div>
      )}

      <p className="pl-foot"><Link to="/risks">Full risk breakdown</Link> · <Link to="/whatif">What-if</Link></p>
    </section>
  );
}
