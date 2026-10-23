import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, ChevronLeft, ChevronRight, Info } from 'lucide-react';
import useAsync from '../hooks/useAsync.js';
import { getMonthlyAnalytics } from '../services/api.js';
import PageHeader from '../components/PageHeader.jsx';
import SectionHead from '../components/SectionHead.jsx';
import StateMessage from '../components/StateMessage.jsx';
import { RiskBadge } from '../components/Badge.jsx';
import { PAYMENT_LABEL, formatInTz, formatMinutes, formatDayInTz } from '../utils/format.js';
import '../css/Analytics.css';

const plural = (n, one, many) => (n === 1 ? one : many);
const monthLabel = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'long', year: 'numeric' });
const shift = (m, n) => { const [y, mo] = m.split('-').map(Number); const t = y * 12 + mo - 1 + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
const MODE = {
  real: ['real', 'Real data from your orders.'],
  demo: ['demo', 'Demo data. These are the sample bakery orders, not a real business history.'],
  mixed: ['mixed', 'Real orders and demo orders are mixed in this month.'],
  empty: ['empty', 'No orders were received this month.'],
};

// A metric the order data cannot support. It says so and names the missing field, rather than showing a made-up number.
const NA = ({ metric }) => <p className="an-na"><Info size={14} aria-hidden="true" /> <span><b>Not available.</b> {metric.reason}</span></p>;

function Kpi({ label, metric, children, hint, tone }) {
  return (
    <div className={`an-kpi${tone ? ` an-kpi-${tone}` : ''}`}>
      <dt>{label}</dt>
      {metric.available ? <><dd>{children ?? metric.value}</dd>{hint && <small>{hint}</small>}</> : <><dd className="an-kpi-na">—</dd><small>{metric.reason}</small></>}
    </div>
  );
}

// Plain SVG-free CSS bars: every chart has a text equivalent (aria-label / table-like list) and tooltips via title.
function HBars({ rows, max, unit = '', label }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="an-bars" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key ?? r.label} title={`${r.label}: ${r.value}${unit}`}>
          <span className="an-bar-label">{r.label}</span>
          <div className="meter"><div className={`meter-fill an-${r.tone ?? 'caramel'}`} style={{ width: `${(r.value / top) * 100}%` }} /></div>
          <span className="an-bar-fig"><b>{r.value}</b>{r.note && <small> {r.note}</small>}</span>
        </li>
      ))}
    </ul>
  );
}

function Columns({ series, label, legend }) {
  const peak = Math.max(1, ...series.flatMap((s) => s.values.map((v) => v.value)));
  return (
    <figure className="an-fig">
      <div className="an-cols" role="img" aria-label={`${label}. Most in one bar: ${peak}.`} style={{ '--n': series[0].values.length }}>
        {series[0].values.map((_, i) => (
          <div key={i} className="an-col" title={series.map((s) => `${s.name}: ${s.values[i].value}`).join(' · ')}>
            <div className="an-col-bars">{series.map((s) => <span key={s.name} className={`an-colbar an-${s.tone}${s.values[i].value ? '' : ' is-empty'}`} style={{ height: `${(s.values[i].value / peak) * 100}%` }}><i>{s.values[i].value || ''}</i></span>)}</div>
            <span className="an-col-label">{series[0].values[i].label}</span>
          </div>
        ))}
      </div>
      <figcaption className="an-legend an-axis"><span>Bar heights are to scale (tallest = {peak}).</span>{legend && series.map((s) => <span key={s.name}><i className={`an-dot an-${s.tone}`} />{s.name}</span>)}</figcaption>
    </figure>
  );
}

function CapacityChart({ days, tz }) {
  const peak = Math.max(60, ...days.map((d) => Math.max(d.capacityMinutes, d.plannedMinutes, d.dueMinutes)));
  return (
    <figure className="an-fig">
      <ol className="an-heat" aria-label="Planned workload against daily capacity for the next 14 days">
        {days.map((d) => {
          const used = d.capacityMinutes ? d.plannedMinutes / d.capacityMinutes : 0;
          const state = d.capacityMinutes === 0 ? 'off' : d.overloaded ? 'full' : used >= 0.6 ? 'busy' : 'free';
          return (
            <li key={d.date} className={`an-day an-day-${state}`} title={`${formatDayInTz(d.date)}: ${d.capacityMinutes ? `${formatMinutes(d.plannedMinutes)} planned of ${formatMinutes(d.capacityMinutes)}` : 'day off'}${d.dueOrders ? ` · ${d.dueOrders} due (${formatMinutes(d.dueMinutes)})` : ''}`}>
              <span className="an-day-dow">{new Date(`${d.date}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short' })}</span>
              <span className="an-day-num">{Number(d.date.slice(8))}</span>
              <span className="an-day-gauge"><i style={{ height: `${d.capacityMinutes ? Math.min(100, used * 100) : 0}%` }} /></span>
              <span className="an-day-fig">{d.capacityMinutes ? `${Math.round(used * 100)}%` : 'off'}</span>
            </li>
          );
        })}
      </ol>
      <figcaption className="an-legend"><span><i className="an-dot an-green" />Spare time</span><span><i className="an-dot an-caramel" />Busy</span><span><i className="an-dot an-red" />Fully booked</span><span><i className="an-dot an-muted" />Day off</span></figcaption>
      <p className="sr-only">{days.filter((d) => d.overloaded).length} of {days.length} days are fully booked. Times are in {tz}. Peak per-day value {peak} minutes.</p>
    </figure>
  );
}

export default function Analytics() {
  const [params, setParams] = useSearchParams();
  const [hours, setHours] = useState('');
  const month = params.get('month') && /^\d{4}-(0[1-9]|1[0-2])$/.test(params.get('month')) ? params.get('month') : undefined;
  const explicit = ['real', 'demo', 'all'].includes(params.get('data')) ? params.get('data') : null;
  const [auto, setAuto] = useState('all'); // the first load asks for everything just to learn how many real and demo orders exist
  const requested = explicit ?? auto;
  const { status, data, error, reload } = useAsync(() => getMonthlyAnalytics(month, requested), [month, requested]);
  useEffect(() => { if (data && !explicit && auto === 'all') setAuto(data.datasets.real > 0 ? 'real' : 'demo'); }, [data, explicit, auto]);
  const goto = (m) => setParams((p) => { const n = new URLSearchParams(p); if (m) n.set('month', m); else n.delete('month'); return n; }, { replace: true });
  const pick = (d) => setParams((p) => { const n = new URLSearchParams(p); n.set('data', d); return n; }, { replace: true });

  const shown = data?.month ?? month;
  const head = (
    <PageHeader eyebrow="Insights" title="Your month, in perspective." demo={false}>
      {data && (
        <div className="an-set" role="group" aria-label="Which orders to include">
          {[['real', 'Real orders', data.datasets.real], ['demo', 'Demo orders', data.datasets.demo], ['all', 'Both', data.datasets.real + data.datasets.demo]].map(([k, l, n]) => (
            <button key={k} type="button" className={data.datasets.selected === k ? 'is-on' : ''} aria-pressed={data.datasets.selected === k} onClick={() => pick(k)}>{l}<b>{n}</b></button>
          ))}
        </div>
      )}
      <div className="an-month" role="group" aria-label="Choose a month">
        <button type="button" className="pc-arrow" onClick={() => goto(shift(shown, -1))} disabled={!shown} aria-label="Previous month"><ChevronLeft size={18} aria-hidden="true" /></button>
        <strong aria-live="polite">{shown ? monthLabel(shown) : '…'}</strong>
        <button type="button" className="pc-arrow" onClick={() => goto(shift(shown, 1))} disabled={!shown || data?.isCurrentMonth} aria-label="Next month"><ChevronRight size={18} aria-hidden="true" /></button>
      </div>
    </PageHeader>
  );

  if (!data && status === 'loading') return <section className="page analytics">{head}<StateMessage kind="loading" message="Gathering your month…" /></section>;
  if (status === 'error' || !data) return <section className="page analytics">{head}<StateMessage kind="error" message={`Couldn't load the monthly dashboard. ${error?.message ?? ''}`} onRetry={reload} /></section>;

  const { overview: ov, sales, fulfilment: fu, payments: pay, customers: cu, capacity: cap, opportunities, quality, timezone: tz } = data;
  const [modeKey, modeText] = MODE[quality.mode];
  const spare = cap.spareMinutes;
  const mins = Number(hours) > 0 ? Math.round(Number(hours) * 60) : null;
  const dueByWeek = fu.dueByWeek;
  const payRows = ['verified', 'pending', 'unverified', 'rejected'].map((k) => ({ key: k, label: PAYMENT_LABEL[k], value: pay.statusCounts[k], tone: k === 'verified' ? 'green' : k === 'rejected' ? 'red' : k === 'pending' ? 'blue' : 'muted' })).filter((r) => r.value > 0);

  return (
    <section className={`page analytics${status === 'loading' ? ' is-loading' : ''}`}>
      {head}
      <p className={`an-quality an-quality-${data.datasets.selected}`} role="status">
        <b>{data.datasets.selected === 'real' ? 'Real orders only' : data.datasets.selected === 'demo' ? 'Demo orders only' : 'Real and demo orders combined'}</b>{' '}
        {data.datasets.selected === 'real' ? (data.datasets.real === 0 ? 'No real orders yet. Switch to Demo orders to see how this page looks with sample data.' : 'Sample orders are left out, so these figures describe your business.')
          : data.datasets.selected === 'demo' ? 'These are the sample bakery orders. They show how Conversa works, not how your business is doing.'
            : 'Figures mix sample and real orders, so they do not describe your business. Use Real orders for that.'}
      </p>

      <dl className="an-kpis an-kpis-3">
        <Kpi label="Orders received" metric={ov.received} tone="key" hint="Created this month, cancelled included" />
        <Kpi label="Orders completed" metric={ov.completed} hint="On-time delivery can't be measured yet: completion times aren't recorded" />
        <Kpi label="Orders at risk" metric={{ available: true, value: fu.atRisk.length }} tone={fu.atRisk.length ? 'risk' : undefined} hint="Open orders the scheduler expects to miss, or barely meet, their deadline" />
      </dl>

      <div className="an-grid an-grid-2 an-main">
        <article className="an-card"><h3>Orders received by week</h3>
          <Columns label="Orders received per week of the month" series={[{ name: 'Orders received', tone: 'caramel', values: sales.receivedByWeek.map((w) => ({ label: w.label, value: w.orders })) }]} />
          <p className="an-note">Revenue can't be charted yet: orders don't store a price. Volume is shown instead.</p>
        </article>
        <article className="an-card"><h3>Popular products <small>by units ordered</small></h3>
          {sales.bestSellers.available ? <HBars label="Products by orders received" rows={[...sales.bestSellers.value].sort((a, b) => b.units - a.units || b.orders - a.orders).map((p) => ({ label: p.product, value: p.units, note: `${plural(p.units, 'unit', 'units')} · ${p.orders} ${plural(p.orders, 'order', 'orders')}` }))} /> : <NA metric={sales.bestSellers} />}
        </article>
      </div>

      <details className="an-moredetail">
        <summary>More detail: reliability, payments, customers, capacity, suggestions</summary>
      <section className="ws-section">
        <SectionHead eyebrow="3 · Reliability" title="Are you keeping your promises?">Orders are grouped by the month their deadline falls in. A prediction is not a late delivery.</SectionHead>
        <div className="an-grid an-grid-2">
          <article className="an-card"><h3>Due versus completed</h3>
            {fu.due === 0 ? <p className="an-note">No orders have a deadline in this month.</p> : <Columns legend label="Orders due and orders completed, by week of the month" series={[{ name: 'Due', tone: 'caramel', values: dueByWeek.map((w) => ({ label: w.label, value: w.due })) }, { name: 'Completed', tone: 'green', values: dueByWeek.map((w) => ({ label: w.label, value: w.completed })) }]} />}
            <p className="an-note"><b>{fu.dueCompleted}</b> of <b>{fu.due}</b> orders due this month are completed.</p>
          </article>
          <article className="an-card"><h3>On time versus late</h3><NA metric={fu.lateCompletions} />
            <h3 className="an-sub">Average fulfilment time</h3><NA metric={fu.averageFulfilmentTime} />
            <h3 className="an-sub">Delay reasons</h3><NA metric={fu.delayReasons} /></article>
        </div>
        <div className="an-card an-wide">
          <h3>Late and at-risk orders</h3>
          {fu.overdueOpen.length === 0 && fu.atRisk.length === 0 ? <p className="an-note">No open order is overdue or predicted to miss its deadline.</p> : (
            <ul className="an-risks">
              {fu.overdueOpen.map((r) => <li key={`o${r.orderId}`}><div><strong>{r.customerName}</strong><span>{r.item}</span></div><div><small>Deadline</small>{formatInTz(r.deadline, tz)}</div><div><small>Status</small>Overdue, still open</div><RiskBadge risk="high" /><Link to={`/orders?edit=${r.orderId}`} className="an-link">Open <ArrowRight size={14} aria-hidden="true" /></Link></li>)}
              {fu.atRisk.filter((r) => r.kind !== 'deadline_passed').map((r) => <li key={r.orderId}><div><strong>{r.customerName}</strong><span>{r.item}</span></div><div><small>Deadline</small>{formatInTz(r.deadline, tz)}</div><div><small>Predicted finish</small>{r.expectedFinish ? formatInTz(r.expectedFinish, tz) : 'Not within 60 days'}</div><RiskBadge risk={r.risk} /><Link to={`/orders?edit=${r.orderId}`} className="an-link">Open <ArrowRight size={14} aria-hidden="true" /></Link><p className="an-why">{r.reason} <em>Predicted by the scheduler.</em></p></li>)}
            </ul>
          )}
          <p className="an-note">{fu.carryover.value} {plural(fu.carryover.value, 'order due', 'orders due')} in {monthLabel(data.month)} {plural(fu.carryover.value, 'is', 'are')} still open{fu.carryover.monthEnded ? ' and carried over into the next month' : ''}. Delay reasons: unknown for every order.</p>
        </div>
      </section>

      <section className="ws-section">
        <SectionHead eyebrow="4 · Payments" title="Booked, collected, outstanding.">Payment status is kept separate from order status. Conversa never treats a note or a screenshot as proof of payment.</SectionHead>
        <div className="an-grid an-grid-2">
          <article className="an-card"><h3>Payment status of orders received</h3>
            {payRows.length ? <HBars label="Orders by payment status" rows={payRows} /> : <p className="an-note">No orders received this month.</p>}
            <p className="an-note">"Verified" is the status you set on an order; it is counted, not summed into money.</p></article>
          <article className="an-card"><h3>Money figures</h3>
            <dl className="an-na-list">
              <div><dt>Payments received</dt><dd>{pay.recordedNotes.available ? `${pay.recordedNotes.value.total.toLocaleString()} noted across ${pay.recordedNotes.value.count} ${plural(pay.recordedNotes.value.count, 'record', 'records')} (seller notes, not verified)` : pay.recordedNotes.reason}</dd></div>
              {[['Outstanding balances', pay.outstanding], ['Advance payments', pay.advances], ['Refunds', pay.refunds], ['Estimated profit', pay.profit]].map(([l, m]) => <div key={l}><dt>{l}</dt><dd>{m.reason}</dd></div>)}
            </dl></article>
        </div>
      </section>

      <section className="ws-section">
        <SectionHead eyebrow="5 · Customers" title="Who to look after.">Customers are only recognised by a recorded contact, never by name alone.</SectionHead>
        <div className="an-grid an-grid-2">
          <article className="an-card"><h3>Repeat customers</h3>{cu.repeatCustomers.available ? <HBars label="Orders per repeat customer" rows={cu.repeatCustomers.value.map((c) => ({ label: c.customerName, value: c.orders }))} unit=" orders" /> : <NA metric={cu.repeatCustomers} />}
            <h3 className="an-sub">Most valuable customers</h3><NA metric={cu.topBySpend} />
            <h3 className="an-sub">Complaints and rework</h3><NA metric={cu.complaints} /></article>
          <article className="an-card"><h3>Suggested follow-ups</h3>
            {cu.followUps.length ? <ul className="an-follow">{cu.followUps.map((f, i) => <li key={`${f.orderId}${i}`}><strong>{f.customerName}</strong><span>{f.reason}</span><em>{f.suggestion}</em><Link to={`/orders?edit=${f.orderId}`} className="an-link">Open order <ArrowRight size={14} aria-hidden="true" /></Link></li>)}</ul> : <p className="an-note">Nothing needs a follow-up right now.</p>}
            <p className="an-note">Suggestions only. Conversa never contacts a customer on its own. Repeat-order reminders: {cu.reorderReminders.reason}</p></article>
        </div>
      </section>

      <section className="ws-section">
        <SectionHead eyebrow="6 · Capacity" title="Can you take on more?">Workload is measured in preparation minutes, not order counts: one large custom cake can outweigh several small orders. This view always covers the next two weeks.</SectionHead>
        <div className="an-card an-wide">
          <h3>Workload against capacity, next 14 days</h3>
          <CapacityChart days={cap.days} tz={tz} />
          <div className="an-cap-grid">
            <div><h4>Fully booked</h4><p>{cap.overloadedDates.length ? cap.overloadedDates.map((d) => formatDayInTz(d)).join(', ') : 'No day is fully booked.'}</p></div>
            <div><h4>Several deadlines on one day</h4><p>{cap.sameDayDeadlines.length ? cap.sameDayDeadlines.map((d) => `${formatDayInTz(d.date)}: ${d.orders} orders, ${formatMinutes(d.minutes)} of preparation`).join(' · ') : 'No day has more than one deadline.'}</p></div>
            <div><h4>Spare capacity</h4><p><b>{formatMinutes(spare)}</b> of preparation time is unbooked in the next {cap.window.days} days.</p></div>
          </div>
          <label className="an-calc">How long would one new order take (hours)? <input type="number" min="0.25" step="0.25" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="e.g. 2" /></label>
          <p className="an-note" aria-live="polite">{mins ? (cap.unschedulable ? `${cap.unschedulable} open ${plural(cap.unschedulable, 'order has', 'orders have')} no preparation time or deadline, so this count may be too high. ` : '') + `At ${formatMinutes(mins)} each, roughly ${Math.floor(spare / mins)} more ${plural(Math.floor(spare / mins), 'order', 'orders')} would fit if their deadlines are far enough away (an estimate: it ignores deadlines).` : 'Enter how long a new order takes to estimate how many more you can accept. Without a duration, no number is claimed.'}</p>
          <p className="an-note">{cap.recurringDelays.reason}</p>
        </div>
      </section>

      <section className="ws-section">
        <SectionHead eyebrow="7 · Next" title="Opportunities for next month.">Only suggestions the data above supports. Nothing here claims to have raised your sales.</SectionHead>
        {opportunities.length === 0 ? <StateMessage message="Not enough data for supported suggestions yet. They appear as orders and history build up." /> : (
          <ol className="an-opps">{opportunities.map((o) => (
            <li key={o.id}><h3>{o.insight}</h3><dl><div><dt>Evidence</dt><dd>{o.evidence}</dd></div><div><dt>Why it matters</dt><dd>{o.why}</dd></div><div><dt>Next action</dt><dd>{o.action}</dd></div></dl><Link to={o.link.to} className="btn btn-sm btn-primary">{o.link.label} <ArrowRight size={14} aria-hidden="true" /></Link></li>
          ))}</ol>
        )}
        <p className="an-note">Rising or falling demand, repeat-order reminders and seasonal occasions need several months of history (and recorded customer contacts). Conversa holds {quality.historyMonths} {plural(quality.historyMonths, 'month', 'months')} of orders, so it doesn't suggest them yet.</p>
      </section>
      </details>
    </section>
  );
}
