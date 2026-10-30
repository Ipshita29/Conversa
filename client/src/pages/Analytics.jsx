import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowDownRight, ArrowRight, ArrowUpRight, CalendarDays, CalendarRange, ChevronDown, CircleCheck, Clock, Flame, IndianRupee, Info, ShoppingBag, Sparkles, TrendingUp, TriangleAlert } from 'lucide-react';
import useAsync from '../hooks/useAsync.js';
import { getInsights } from '../services/api.js';
import { DemoBadge, StateMessage } from '../components/UI.jsx';
import { CARAMEL, ComboChart, Donut, INK, SOFT, Sparkline, compact } from '../components/Charts.jsx';
import '../css/Insights.css';

// Soft, low-opacity decoration in the page margins only. It loads on demand and the dashboard is fully usable without it.
const EdgeFacets = lazy(() => import('../components/EdgeFacets.jsx'));

const plural = (n, one, many) => (n === 1 ? one : many);
const inr = (n) => `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: n % 1 ? 2 : 0 }).format(n)}`;
const utc = (iso) => new Date(`${iso}T00:00:00Z`);
const short = (iso) => utc(iso).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
const long = (iso) => utc(iso).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const RANGES = [[7, '7 days'], [30, '30 days'], [90, '3 months']];

// Whole percentages that add up to exactly 100 (largest-remainder), so the legend always reconciles with the donut.
function percents(values) {
  const total = values.reduce((s, v) => s + v, 0);
  if (!total) return values.map(() => 0);
  const raw = values.map((v) => (v / total) * 100); const out = raw.map(Math.floor);
  let left = 100 - out.reduce((s, v) => s + v, 0);
  raw.map((r, i) => [r - out[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0 && values[i] > 0) { out[i] += 1; left -= 1; } });
  return out;
}

// ---- Date range: quick filters plus a custom period -------------------------------------------------------------------------
function DateRange({ range, custom, days, onQuick, onCustom }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(range.from); const [to, setTo] = useState(range.to); const [err, setErr] = useState(null);
  const box = useRef(null);
  const today = new Date().toLocaleDateString('en-CA');
  useEffect(() => { setFrom(range.from); setTo(range.to); setErr(null); }, [range.from, range.to, open]);
  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const key = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  const apply = () => {
    if (!from || !to) return setErr('Choose both dates.');
    if (from > to) return setErr('The start date must be on or before the end date.');
    if (to > today) return setErr('The end date cannot be in the future.');
    if ((utc(to) - utc(from)) / 86400000 + 1 > 366) return setErr('Choose a period of at most a year.');
    setOpen(false); onCustom(from, to);
  };
  return (
    <div className="in-range" ref={box}>
      <button type="button" className="in-datebtn" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        <CalendarRange size={16} aria-hidden="true" /><span>{short(range.from)} – {short(range.to)} {range.to.slice(0, 4)}</span><ChevronDown size={15} aria-hidden="true" />
      </button>
      <div className="in-quick" role="group" aria-label="Quick range">
        {RANGES.map(([d, l]) => <button key={d} type="button" className={!custom && days === d ? 'is-on' : ''} aria-pressed={!custom && days === d} onClick={() => onQuick(d)}>{l}</button>)}
      </div>
      {open && (
        <div className="in-pop" role="dialog" aria-label="Choose a date range">
          <label>From<input type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>To<input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} /></label>
          {err && <p className="in-pop-err" role="alert">{err}</p>}
          <div className="in-pop-actions"><button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>Cancel</button><button type="button" className="btn btn-primary btn-sm" onClick={apply}>Apply</button></div>
        </div>
      )}
    </div>
  );
}

// ---- KPI card ------------------------------------------------------------------------------------------------------------------
function Change({ c, days }) {
  if (!c || !c.available) return <span className="in-change is-muted" title={c?.reason}>Not enough data yet</span>;
  if (c.change === null) return <span className="in-change is-muted">Nothing to compare with</span>;
  const up = c.change > 0; const flat = c.change === 0;
  const unit = c.unit === 'points' ? ' pts' : '%';
  return (
    <span className={`in-change ${flat ? 'is-muted' : up ? 'is-up' : 'is-down'}`} title={`Previous ${days} days: ${c.previous}${c.unit === 'points' ? '%' : ''}`}>
      {flat ? null : up ? <ArrowUpRight size={14} aria-hidden="true" /> : <ArrowDownRight size={14} aria-hidden="true" />}
      {flat ? 'Same as' : `${Math.abs(c.change)}${unit}`} vs previous {days} {plural(days, 'day', 'days')}
    </span>
  );
}

function Kpi({ Icon, tone, label, children, spark, sparkColor }) {
  return (
    <div className={`in-kpi is-${tone}`}>
      <header><span className="in-ico"><Icon size={18} aria-hidden="true" /></span><span className="in-label">{label}</span></header>
      <div className="in-kpi-body"><div className="in-kpi-main">{children}</div>{spark && <Sparkline values={spark} color={sparkColor} />}</div>
    </div>
  );
}

const INSIGHT_ICON = { 'deadline-risk': TriangleAlert, overload: Flame, 'best-seller': TrendingUp, 'busiest-day': CalendarDays, 'missing-prices': IndianRupee };

export default function Analytics() {
  const [params, setParams] = useSearchParams();
  const fromP = params.get('from'); const toP = params.get('to');
  const custom = /^\d{4}-\d{2}-\d{2}$/.test(fromP ?? '') && /^\d{4}-\d{2}-\d{2}$/.test(toP ?? '') ? { from: fromP, to: toP } : null;
  const rangeP = Number(params.get('range'));
  const days = [7, 30, 90].includes(rangeP) ? rangeP : 7; // the last 7 days unless told otherwise
  const explicit = ['real', 'demo', 'all'].includes(params.get('data')) ? params.get('data') : null;
  const [auto, setAuto] = useState('all'); // the first load asks for everything just to learn how many real and demo orders exist
  const requested = explicit ?? auto;
  const [mode, setMode] = useState('combined');
  const [rank, setRank] = useState('revenue');
  const { status, data, error, reload } = useAsync(() => getInsights(custom ?? days, requested), [days, custom?.from, custom?.to, requested]);
  useEffect(() => { if (data && !explicit && auto === 'all') setAuto(data.datasets.real > 0 ? 'real' : 'demo'); }, [data, explicit, auto]);
  const setP = (changes) => setParams((p) => { const n = new URLSearchParams(p); Object.entries(changes).forEach(([k, v]) => (v === null ? n.delete(k) : n.set(k, v))); return n; }, { replace: true });

  const trendPoints = useMemo(() => {
    if (!data) return [];
    const t = data.trend;
    if (t.length <= 31) return t.map((d) => ({ label: t.length <= 8 ? utc(d.date).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric' }) : short(d.date), full: long(d.date), bar: d.revenue, line: d.orders }));
    const out = []; // long periods are drawn week by week so every bar stays readable
    for (let i = 0; i < t.length; i += 7) { const w = t.slice(i, i + 7); out.push({ label: short(w[0].date), full: `${short(w[0].date)} – ${short(w.at(-1).date)}`, bar: w.reduce((s, d) => s + d.revenue, 0), line: w.reduce((s, d) => s + d.orders, 0) }); }
    return out;
  }, [data]);

  const head = (
    <header className="in-head">
      <div className="in-title">
        <p className="in-eyebrow">Business insights</p>
        <h1>Your business <em>at a glance.</em></h1>
        <p className="in-sub">See how your orders, revenue and capacity are doing, and what to focus on next.</p>
      </div>
      <div className="in-controls">
        {data ? <DateRange range={data.range} custom={Boolean(custom)} days={days} onQuick={(d) => setP({ range: d === 7 ? null : d, from: null, to: null })} onCustom={(f, t) => setP({ from: f, to: t, range: null })} />
          : <div className="in-quick" role="group" aria-label="Quick range">{RANGES.map(([d, l]) => <button key={d} type="button" className={days === d ? 'is-on' : ''} onClick={() => setP({ range: d === 7 ? null : d, from: null, to: null })}>{l}</button>)}</div>}
        <div className="in-datasets">
          {data && (data.datasets.real > 0 && data.datasets.demo > 0 || data.datasets.selected === 'demo') && (
            <div className="in-seg" role="group" aria-label="Which orders">
              {[['real', 'Real', data.datasets.real], ['demo', 'Demo', data.datasets.demo], ['all', 'Both', data.datasets.real + data.datasets.demo]].map(([k, l, n]) => (
                <button key={k} type="button" className={data.datasets.selected === k ? 'is-on' : ''} aria-pressed={data.datasets.selected === k} onClick={() => setP({ data: k })}>{l}<b>{n}</b></button>
              ))}
            </div>
          )}
          <DemoBadge />
        </div>
      </div>
    </header>
  );

  const shell = (inner, cls = '') => (
    <section className={`page insights${cls}`}>
      <Suspense fallback={null}><EdgeFacets /></Suspense>
      <div className="in-content">{head}{inner}</div>
    </section>
  );
  if (!data && status === 'loading') return shell(<StateMessage kind="loading" message="Gathering your numbers…" />);
  if (status === 'error' || !data) return shell(<StateMessage kind="error" message={`Couldn't load your insights. ${error?.message ?? ''}`} onRetry={reload} />);

  const { kpis, trend, products, insights, datasets, status: st, timing } = data;
  const periodDays = data.range.days;
  const sel = datasets.selected;
  const revOn = kpis.totalRevenue.available;
  const effMode = !revOn && mode !== 'orders' ? 'orders' : mode;
  const show = { bar: effMode !== 'orders' && revOn, line: effMode !== 'revenue' };
  const rate = kpis.onTimeRate;
  // Delivery cards exist only when the selected period (and Real/Demo/Both choice) has orders really delivered: completed, with a promised deadline.
  const hasDelivery = timing.delivered > 0;
  const completedPct = kpis.totalOrders.value ? Math.round((kpis.completedOrders.value / kpis.totalOrders.value) * 100) : null;
  const rateSeries = trend.map((d) => (d.delivered ? Math.round((d.onTime / d.delivered) * 100) : null));

  const statusRows = [['completed', 'Completed', '#7FA97A'], ['pending', 'Pending', SOFT.blue], ['cancelled', 'Cancelled', '#C9C1B4'], ['atRisk', 'At risk', '#E39A6B']].map(([k, label, color]) => ({ key: k, label, color, value: st[k] }));
  const statusPct = percents(statusRows.map((r) => r.value));
  const timingRows = [{ key: 'onTime', label: 'On time', color: '#7FA97A', value: timing.onTime }, { key: 'delayed', label: 'Delayed', color: '#E39A6B', value: timing.delayed }];
  const timingPct = percents(timingRows.map((r) => r.value));

  const sorted = [...products].sort((a, b) => (rank === 'units' ? b.units - a.units || (b.revenue ?? -1) - (a.revenue ?? -1) : (b.revenue ?? -1) - (a.revenue ?? -1) || b.units - a.units)).slice(0, 5);
  const peak = Math.max(...sorted.map((p) => (rank === 'units' ? p.units : p.revenue ?? 0)), 0);
  const noOrders = st.total === 0;

  return shell(
    <>
      {sel !== 'real' && <p className="in-note"><Info size={14} aria-hidden="true" /> {sel === 'demo' ? 'Demo orders only: sample bakery data, not your business.' : 'Real and demo orders combined: these figures mix sample and real data.'}</p>}

      <div className={`in-body${status === 'loading' ? ' is-loading' : ''}`}>
        <div className={`in-kpis ${hasDelivery ? 'has-4' : 'has-3'}`}>
          <Kpi Icon={IndianRupee} tone="caramel" label="Total revenue" spark={revOn ? trend.map((d) => d.revenue) : null} sparkColor={CARAMEL}>
            {revOn ? <><b className="in-val">{inr(kpis.totalRevenue.value)}</b><Change c={kpis.totalRevenue.comparison} days={periodDays} /><small>{kpis.totalRevenue.unpricedOrders ? `Booked sales · ${kpis.totalRevenue.unpricedOrders} ${plural(kpis.totalRevenue.unpricedOrders, 'order has', 'orders have')} no price` : 'Booked sales, not money collected'}</small></>
              : <><b className="in-val is-na">—</b><span className="in-change is-muted">Not enough data yet</span><small>{kpis.totalRevenue.reason}</small></>}
          </Kpi>
          <Kpi Icon={ShoppingBag} tone="blue" label="Total orders" spark={trend.map((d) => d.orders)} sparkColor={INK}>
            <b className="in-val">{kpis.totalOrders.value}</b><Change c={kpis.totalOrders.comparison} days={periodDays} /><small>Received, cancelled excluded</small>
          </Kpi>
          <Kpi Icon={CircleCheck} tone="green" label="Completed orders" spark={trend.map((d) => d.completed)} sparkColor="#5E9460">
            <b className="in-val">{kpis.completedOrders.value}</b><Change c={kpis.completedOrders.comparison} days={periodDays} /><small>{completedPct === null ? 'No orders received' : `${completedPct}% of ${kpis.totalOrders.value} received`}</small>
          </Kpi>
          {hasDelivery && (
            <Kpi Icon={Clock} tone="blue" label="On-time delivery rate" spark={rateSeries} sparkColor={INK}>
              <b className="in-val">{rate.value}%</b><Change c={rate.comparison} days={periodDays} /><small>{rate.onTime} of {rate.delivered} delivered on or before the deadline</small>
            </Kpi>
          )}
        </div>

        {noOrders ? <StateMessage message={`No orders were received in this period. Add an order, or choose another range.`}><Link className="btn btn-primary" to="/orders">Go to Orders</Link></StateMessage> : (
          <div className="in-main">
            <article className="in-card in-trend">
              <header className="in-card-head">
                <div><h2>Revenue &amp; orders trend</h2><p>{show.bar ? 'Booked revenue per ' : 'Orders per '}{trend.length > 31 ? 'week' : 'day'}{show.bar && show.line ? ', with orders received' : ''}</p></div>
                <div className="in-seg" role="group" aria-label="Chart shows">
                  {[['combined', 'Combined'], ['revenue', 'Revenue'], ['orders', 'Orders']].map(([k, l]) => <button key={k} type="button" disabled={!revOn && k !== 'orders' && k !== 'combined'} className={effMode === k ? 'is-on' : ''} aria-pressed={effMode === k} onClick={() => setMode(k)}>{l}</button>)}
                </div>
              </header>
              {!revOn && <p className="in-chart-note">Revenue appears here once your orders have prices. Showing orders for now.</p>}
              <ComboChart points={trendPoints} show={show} barName="Revenue (booked)" lineName="Orders" fmtBar={inr} fmtLine={(v) => `${v} ${plural(v, 'order', 'orders')}`} tickBar={(v) => `₹${compact(v)}`} height={372}
                ariaLabel={`${show.bar ? 'Booked revenue' : 'Orders'} ${trend.length > 31 ? 'by week' : 'by day'}. ${trendPoints.map((p) => `${p.full}: ${show.bar ? `${inr(p.bar)}, ` : ''}${p.line} ${plural(p.line, 'order', 'orders')}`).join('. ')}`} />
              <ul className="in-legend">
                {show.bar && <li><i className="sw bar" />Revenue (booked)</li>}
                {show.line && <li><i className="sw line" />Orders</li>}
              </ul>
            </article>

            <article className="in-card in-products">
              <header className="in-card-head">
                <div><h2>Top-selling products</h2><p>{rank === 'revenue' ? 'Booked revenue' : 'Units sold'}, received in this period</p></div>
                <div className="in-seg" role="group" aria-label="Rank by">
                  {[['revenue', 'Revenue'], ['units', 'Units']].map(([k, l]) => <button key={k} type="button" className={rank === k ? 'is-on' : ''} aria-pressed={rank === k} onClick={() => setRank(k)}>{l}</button>)}
                </div>
              </header>
              {sorted.length === 0 ? <p className="in-empty">No products in this period.</p> : (
                <ol>
                  {sorted.map((p, i) => {
                    const v = rank === 'units' ? p.units : p.revenue ?? 0;
                    return (
                      <li key={p.product}>
                        <span className="in-rank">{i + 1}</span>
                        <div className="in-prod"><strong title={p.product}>{p.product}</strong><small>{p.units} {plural(p.units, 'unit', 'units')} · {p.orders} {plural(p.orders, 'order', 'orders')}</small>
                          <span className="in-meter" aria-hidden="true"><i style={{ width: peak ? `${Math.max(v ? 4 : 0, (v / peak) * 100)}%` : '0%' }} /></span></div>
                        <span className={`in-rev${p.revenue == null ? ' is-na' : ''}`}>{p.revenue == null ? 'No price yet' : inr(p.revenue)}{p.partial && <small>some unpriced</small>}</span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </article>
          </div>
        )}

        <div className={`in-bottom ${hasDelivery ? 'has-3' : 'has-2'}`}>
          <article className="in-card in-status">
            <header className="in-card-head"><div><h2>Order status</h2><p>All orders received in this period, cancelled included</p></div></header>
            <div className="in-donut-row">
              <Donut slices={statusRows} centerTop={String(st.total)} centerBottom={plural(st.total, 'order', 'orders')} ariaLabel={`Order status: ${statusRows.map((r) => `${r.value} ${r.label}`).join(', ')}, ${st.total} in total`} />
              <ul className="in-keys">{statusRows.map((r, i) => <li key={r.key}><i style={{ background: r.color }} /><span>{r.label}</span><b>{r.value}</b><em>{statusPct[i]}%</em></li>)}</ul>
            </div>
          </article>

          {hasDelivery && (
            <article className="in-card in-timing">
              <header className="in-card-head"><div><h2>Order timing</h2><p>Delivered orders, against the promised deadline</p></div></header>
              <div className="in-donut-row">
                <Donut slices={timingRows} centerTop={`${timingPct[0]}%`} centerBottom="on time" ariaLabel={`${timing.onTime} of ${timing.delivered} delivered orders were on time`} />
                <ul className="in-keys">{timingRows.map((r, i) => <li key={r.key}><i style={{ background: r.color }} /><span>{r.label}</span><b>{r.value}</b><em>{timingPct[i]}%</em></li>)}
                  <li className="is-total"><span>Delivered</span><b>{timing.delivered}</b></li></ul>
              </div>
            </article>
          )}

          <article className="in-card in-ai">
            <header className="in-card-head"><div><h2><Sparkles size={17} aria-hidden="true" /> Smart insights</h2><p>Worked out from your orders and schedule</p></div></header>
            {insights.length === 0 ? <p className="in-empty">Nothing needs your attention. Insights appear here as your orders and schedule give a reason.</p> : (
              <ul>
                {insights.map((i) => {
                  const Icon = INSIGHT_ICON[i.id] ?? Sparkles;
                  return (
                    <li key={i.id} className={`is-${i.tone}`}>
                      <span className="in-ico"><Icon size={16} aria-hidden="true" /></span>
                      <div><h3>{i.title}</h3><p>{i.finding}</p>{i.link && <Link to={i.link.to} className="in-link">{i.link.label} <ArrowRight size={13} aria-hidden="true" /></Link>}</div>
                    </li>
                  );
                })}
              </ul>
            )}
          </article>
        </div>
      </div>
      <p className="in-basis">{data.basis}{hasDelivery ? ' Delivery timing uses the moment an order was moved to Completed.' : ''}</p>
    </>,
    status === 'loading' ? ' is-loading' : '',
  );
}
