import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react';
import useAsync from '../hooks/useAsync.js';
import { getBoard } from '../services/api.js';
import StateMessage from '../components/StateMessage.jsx';
import DemoBadge from '../components/DemoBadge.jsx';
import { formatMinutes, isDemoOrder } from '../utils/format.js';
import '../css/Plan.css';

const plural = (n, one, many) => (n === 1 ? one : many);
const COLUMNS = [
  { key: 'overdue', title: 'Overdue', hint: 'Needs attention now' },
  { key: 'onTrack', title: 'On track', hint: 'Enough time to finish' },
  { key: 'upcoming', title: 'Upcoming', hint: 'Prepare soon' },
];
const dueText = (iso, tz) => {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
  return `${day} · ${time}`;
};
const dayKey = (iso, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const dayName = (key) => new Date(`${key}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });

// The board is computed by the server (GET /api/board): the same scheduler that powers the plan decides which section each order
// belongs in, so a new or edited order moves to the right place by itself. This page only draws it.
export default function Plan() {
  const [params, setParams] = useSearchParams();
  const explicit = ['real', 'demo', 'all'].includes(params.get('data')) ? params.get('data') : null;
  const [auto, setAuto] = useState('all'); // the first load asks for everything just to learn how many real and demo orders exist
  const requested = explicit ?? auto;
  const { status, data, error, reload } = useAsync(() => getBoard(requested), [requested]);
  const [day, setDay] = useState('all'); // filter by the day an order is due
  useEffect(() => { if (data && !explicit && auto === 'all') setAuto(data.datasets.demo > 0 ? 'demo' : 'real'); }, [data, explicit, auto]);
  const pick = (k) => setParams((p) => { const n = new URLSearchParams(p); n.set('data', k); return n; }, { replace: true });

  const head = (extra) => (
    <header className="bd-head">
      <div>
        <h1>Production board</h1>
        <p>Your orders, automatically sorted by urgency.{data && <b>{data.total} {plural(data.total, 'order', 'orders')}</b>}</p>
      </div>
      <div className="bd-head-side">{extra}<DemoBadge /></div>
    </header>
  );
  if (!data && status === 'loading') return <section className="page plan">{head()}<StateMessage kind="loading" message="Sorting your orders…" /></section>;
  if (status === 'error' || !data) return <section className="page plan">{head()}<StateMessage kind="error" message={`Couldn't load your board. ${error?.message ?? ''}`} onRetry={reload} /></section>;

  const { sections, counts, datasets, timezone: tz, needsDetails } = data;
  const all = [...sections.overdue, ...sections.onTrack, ...sections.upcoming];
  const dueDays = [...new Set(all.map((x) => dayKey(x.deadline, tz)))].sort();
  const navList = ['all', ...dueDays];
  const idx = Math.max(0, navList.indexOf(day));
  const shown = (key) => sections[key].filter((x) => day === 'all' || dayKey(x.deadline, tz) === day);

  const controls = (
    <>
      {datasets.real > 0 && datasets.demo > 0 && (
        <div className="bd-seg" role="group" aria-label="Which orders">
          {[['real', 'Real', datasets.real], ['demo', 'Demo', datasets.demo], ['all', 'Both', datasets.real + datasets.demo]].map(([k, l, n]) => (
            <button key={k} type="button" className={datasets.selected === k ? 'is-on' : ''} aria-pressed={datasets.selected === k} onClick={() => pick(k)}>{l}<b>{n}</b></button>
          ))}
        </div>
      )}
      {dueDays.length > 0 && (
        <div className="bd-seg bd-day" role="group" aria-label="Filter by due day">
          <button type="button" onClick={() => setDay(navList[idx - 1])} disabled={idx === 0} aria-label="Previous day"><ChevronLeft size={15} aria-hidden="true" /></button>
          <span aria-live="polite">{day === 'all' ? 'All days' : `Due ${dayName(day)}`}</span>
          <button type="button" onClick={() => setDay(navList[idx + 1])} disabled={idx >= navList.length - 1} aria-label="Next day"><ChevronRight size={15} aria-hidden="true" /></button>
        </div>
      )}
    </>
  );

  return (
    <section className={`page plan${status === 'loading' ? ' is-loading' : ''}`}>
      {head(controls)}

      {data.total === 0 && needsDetails.length === 0 ? (
        <StateMessage message="No open orders right now. New orders are sorted here automatically.">
          <Link className="btn btn-primary" to="/orders">Go to Orders</Link>
        </StateMessage>
      ) : (
        <div className="bd-board">
          {COLUMNS.map((c) => {
            const list = shown(c.key);
            return (
              <section key={c.key} className={`bd-col is-${c.key}`} aria-label={`${c.title}, ${list.length} ${plural(list.length, 'order', 'orders')}`}>
                <header className="bd-col-head"><h2>{c.title}</h2><b aria-hidden="true">{counts[c.key]}</b><span>{c.hint}</span></header>
                {list.length === 0 ? <p className="bd-none">{day === 'all' ? 'No orders here.' : 'None due on this day.'}</p> : (
                  <ul className="bd-cards">
                    {list.map((x) => (
                      <li key={x.id}>
                        <Link to={`/orders?edit=${x.id}`} className="bd-card" aria-label={`${x.customerName}, ${x.item}, ${c.title}. Open order.`}>
                          <span className="bd-who">{x.customerName}{x.isDemo && <span className="demo-tag">Demo</span>}</span>
                          <span className="bd-what">{x.item}{x.quantity > 1 ? ` × ${x.quantity}` : ''}</span>
                          <span className="bd-meta">
                            <span className="bd-due">Due {dueText(x.deadline, tz)}</span>
                            {x.prepTimeMinutes != null && <span className="bd-prep">{formatMinutes(x.prepTimeMinutes)} prep</span>}
                          </span>
                          <span className="bd-reason"><em className={`bd-status is-${c.key}`}>{x.label}</em>{x.reason}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}

      {needsDetails.length > 0 && (
        <p className="bd-note">
          {needsDetails.length} {plural(needsDetails.length, 'order has', 'orders have')} no preparation time or deadline yet, so {plural(needsDetails.length, 'it is', 'they are')} not on the board:{' '}
          {needsDetails.map((n, i) => <span key={n.id}>{i > 0 && ', '}<Link to={`/orders?edit=${n.id}`}>{n.customerName}</Link></span>)}.
        </p>
      )}
      <p className="bd-foot">Finished orders move to <Link to="/orders">Orders</Link> <ArrowRight size={12} aria-hidden="true" /> · <Link to="/risks">Full risk breakdown</Link> · <Link to="/whatif">What-if</Link></p>
    </section>
  );
}
