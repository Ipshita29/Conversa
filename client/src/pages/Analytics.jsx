import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, ArrowDownRight, ArrowUpRight, Info } from 'lucide-react';
import useAsync from '../hooks/useAsync.js';
import { getInsights } from '../services/api.js';
import { DemoBadge, StateMessage } from '../components/UI.jsx';
import { formatMoney } from '../utils/format.js';
import '../css/Insights.css';

const plural = (n, one, many) => (n === 1 ? one : many);
const dayLabel = (iso, days, i) => {
  const d = new Date(`${iso}T00:00:00Z`);
  if (days <= 7) return `${d.toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short' })} ${d.getUTCDate()}`;
  return i % 5 === 0 || i === days - 1 ? d.toLocaleDateString(undefined, { timeZone: 'UTC', day: 'numeric', month: 'short' }) : '';
};
const fullDay = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });

function Change({ c, days, money }) {
  if (!c) return null;
  if (!c.available) return <span className="in-sub in-muted" title={c.reason}>No comparison yet</span>;
  if (c.change === null) return <span className="in-sub in-muted">Nothing to compare with</span>;
  const up = c.change >= 0;
  return <span className={`in-sub ${c.change === 0 ? 'in-muted' : up ? 'is-up' : 'is-down'}`} title={`Previous ${days} days: ${money ? formatMoney(c.previous) : c.previous}`}>{c.change === 0 ? 'Same as' : up ? <ArrowUpRight size={13} aria-hidden="true" /> : <ArrowDownRight size={13} aria-hidden="true" />}{c.change !== 0 && ` ${Math.abs(c.change)}%`} vs previous {days} days</span>;
}

function Kpi({ label, metric, days, money, note, children }) {
  return (
    <div className="in-kpi">
      <dt>{label}</dt>
      {metric.available ? <><dd>{money ? formatMoney(metric.value) : metric.value}</dd><Change c={metric.comparison} days={days} money={money} />{note && <small>{note}</small>}</>
        : <><dd className="is-na">—</dd><small>{metric.reason}</small></>}
      {children}
    </div>
  );
}

// Bars drawn to scale: the tallest bar is the tallest value, and every other bar is its true fraction of it.
function TrendChart({ trend, days, mode, revenueAvailable }) {
  const values = trend.map((t) => (mode === 'revenue' ? t.revenue : t.orders));
  const peak = Math.max(...values, 0);
  if (mode === 'revenue' && !revenueAvailable) return <p className="in-empty">Revenue appears here once your orders have prices. Switch to Orders to see volume.</p>;
  if (peak === 0) return <p className="in-empty">No {mode === 'revenue' ? 'revenue' : 'orders'} in this period.</p>;
  const text = trend.map((t, i) => `${fullDay(t.date)}: ${mode === 'revenue' ? formatMoney(values[i]) : `${values[i]} ${plural(values[i], 'order', 'orders')}`}`).join('. ');
  return (
    <figure className="in-chart">
      <div className="in-bars" role="img" aria-label={`${mode === 'revenue' ? 'Revenue' : 'Orders'} per day. ${text}`} style={{ '--n': days }}>
        {trend.map((t, i) => (
          <div key={t.date} className="in-bar" title={`${fullDay(t.date)}: ${mode === 'revenue' ? formatMoney(values[i]) : `${values[i]} ${plural(values[i], 'order', 'orders')}`}`}>
            <span className="in-bar-val">{days <= 7 && values[i] ? (mode === 'revenue' ? formatMoney(values[i]) : values[i]) : ''}</span>
            <span className={`in-bar-fill${values[i] ? '' : ' is-zero'}`} style={{ height: `${(values[i] / peak) * 100}%` }} />
            <span className="in-bar-day">{dayLabel(t.date, days, i)}</span>
          </div>
        ))}
      </div>
      <figcaption>Tallest bar: {mode === 'revenue' ? formatMoney(peak) : `${peak} ${plural(peak, 'order', 'orders')}`} in one day.</figcaption>
    </figure>
  );
}

export default function Analytics() {
  const [params, setParams] = useSearchParams();
  const days = params.get('range') === '30' ? 30 : 7;
  const explicit = ['real', 'demo', 'all'].includes(params.get('data')) ? params.get('data') : null;
  const [auto, setAuto] = useState('all'); // the first load asks for everything just to learn how many real and demo orders exist
  const requested = explicit ?? auto;
  const [mode, setMode] = useState('revenue');
  const { status, data, error, reload } = useAsync(() => getInsights(days, requested), [days, requested]);
  useEffect(() => { if (data && !explicit && auto === 'all') setAuto(data.datasets.real > 0 ? 'real' : 'demo'); }, [data, explicit, auto]);
  const set = (k, v) => setParams((p) => { const n = new URLSearchParams(p); n.set(k, v); return n; }, { replace: true });

  const head = (
    <header className="in-head">
      <div><h1>Insights</h1><p>How your orders and sales are doing.</p></div>
      <div className="in-controls">
        <div className="in-seg" role="group" aria-label="Period">
          {[7, 30].map((d) => <button key={d} type="button" className={days === d ? 'is-on' : ''} aria-pressed={days === d} onClick={() => set('range', d)}>Last {d} days</button>)}
        </div>
        {data && (data.datasets.real > 0 && data.datasets.demo > 0 || data.datasets.selected === 'demo') && (
          <div className="in-seg" role="group" aria-label="Which orders">
            {[['real', 'Real', data.datasets.real], ['demo', 'Demo', data.datasets.demo], ['all', 'Both', data.datasets.real + data.datasets.demo]].map(([k, l, n]) => (
              <button key={k} type="button" className={data.datasets.selected === k ? 'is-on' : ''} aria-pressed={data.datasets.selected === k} onClick={() => set('data', k)}>{l}<b>{n}</b></button>
            ))}
          </div>
        )}
        <DemoBadge />
      </div>
    </header>
  );
  if (!data && status === 'loading') return <section className="page insights">{head}<StateMessage kind="loading" message="Gathering your numbers…" /></section>;
  if (status === 'error' || !data) return <section className="page insights">{head}<StateMessage kind="error" message={`Couldn't load your insights. ${error?.message ?? ''}`} onRetry={reload} /></section>;

  const { kpis, trend, topProducts, insights, datasets } = data;
  const sel = datasets.selected;
  const none = kpis.totalOrders.value === 0;

  return (
    <section className={`page insights${status === 'loading' ? ' is-loading' : ''}`}>
      {head}
      {sel !== 'real' && <p className="in-note"><Info size={14} aria-hidden="true" /> {sel === 'demo' ? 'Demo orders only: sample bakery data, not your business.' : 'Real and demo orders combined: these figures mix sample and real data.'}</p>}

      <dl className="in-kpis">
        <Kpi label="Total revenue" metric={kpis.totalRevenue} days={days} money note={kpis.totalRevenue.available && kpis.totalRevenue.unpricedOrders ? `${kpis.totalRevenue.unpricedOrders} ${plural(kpis.totalRevenue.unpricedOrders, 'order has', 'orders have')} no price` : 'Booked sales'} />
        <Kpi label="Total orders" metric={kpis.totalOrders} days={days} note="Received, cancelled excluded" />
        <Kpi label="Completed orders" metric={kpis.completedOrders} days={days} note={`of ${kpis.totalOrders.value} received`} />
        <Kpi label="Average order value" metric={kpis.averageOrderValue} days={days} money note={kpis.averageOrderValue.available ? `across ${kpis.averageOrderValue.pricedOrders} priced ${plural(kpis.averageOrderValue.pricedOrders, 'order', 'orders')}` : null} />
      </dl>

      {none ? <StateMessage message={`No orders were received in the last ${days} days. Add an order, or switch the period.`}><Link className="btn btn-primary" to="/orders">Go to Orders</Link></StateMessage> : (
        <>
          <div className="in-grid">
            <article className="in-card in-trend">
              <header className="in-card-head">
                <h2>Revenue &amp; orders</h2>
                <div className="in-seg" role="group" aria-label="Chart shows">
                  {[['revenue', 'Revenue'], ['orders', 'Orders']].map(([k, l]) => <button key={k} type="button" className={mode === k ? 'is-on' : ''} aria-pressed={mode === k} onClick={() => setMode(k)}>{l}</button>)}
                </div>
              </header>
              <TrendChart trend={trend} days={days} mode={mode} revenueAvailable={kpis.totalRevenue.available} />
            </article>

            <article className="in-card in-products">
              <header className="in-card-head"><h2>Top-selling products</h2><span>by units</span></header>
              <ol>
                {topProducts.map((p, i) => (
                  <li key={p.product}>
                    <span className="in-rank">{i + 1}</span>
                    <div><strong>{p.product}</strong><small>{p.units} {plural(p.units, 'unit', 'units')} · {p.orders} {plural(p.orders, 'order', 'orders')}</small></div>
                    <span className={`in-rev${p.revenue == null ? ' is-na' : ''}`}>{p.revenue == null ? 'No price yet' : formatMoney(p.revenue)}{p.partial && <small>some orders unpriced</small>}</span>
                  </li>
                ))}
              </ol>
            </article>
          </div>

          <article className="in-card in-insights">
            <header className="in-card-head"><h2>Conversa insights</h2><span>from your orders and schedule</span></header>
            {insights.length === 0 ? <p className="in-empty">Not enough orders yet for a reliable insight. They appear as your order history grows.</p> : (
              <ul>
                {insights.map((i) => (
                  <li key={i.id} className={`is-${i.tone}`}>
                    <h3>{i.title}</h3>
                    <p>{i.finding}</p>
                    <p className="in-action"><b>Next:</b> {i.action}</p>
                    <Link to={i.link.to} className="in-link">{i.link.label} <ArrowRight size={13} aria-hidden="true" /></Link>
                  </li>
                ))}
              </ul>
            )}
          </article>
        </>
      )}
      <p className="in-basis">{data.basis}</p>
    </section>
  );
}
