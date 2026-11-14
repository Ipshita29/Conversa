import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion, useInView } from 'framer-motion';
import useAsync from '../hooks/useAsync.js';
import useLive from '../hooks/useLive.js';
import usePrefersReducedMotion from '../hooks/usePrefersReducedMotion.js';
import { attachmentSrc, getInsights } from '../services/api.js';
import { StateMessage } from '../components/UI.jsx';
import '../css/InsightsStory.css';


const RANGES = [[7, '7 days'], [30, '30 days'], [90, '3 months']];
const inr = (n) => `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(n))}`;
const plural = (n, one, many) => (n === 1 ? one : many);
const dayLong = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'short' });
const dayShort = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
const ease = [0.22, 0.61, 0.36, 1];

// A number that counts up to its value (and re-counts when the value changes). Reduced motion: it just shows the value.
function useCount(value, reduced, ms = 1100) {
  const [shown, setShown] = useState(reduced ? value : 0); const from = useRef(reduced ? value : 0);
  useEffect(() => {
    if (reduced) { setShown(value); from.current = value; return undefined; }
    const a = from.current; const t0 = performance.now(); let raf = 0;
    const step = (now) => { const p = Math.min(1, (now - t0) / ms); const e = 1 - (1 - p) ** 4; setShown(a + (value - a) * e); if (p < 1) raf = requestAnimationFrame(step); else from.current = value; };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, reduced, ms]);
  return shown;
}

// Cards lean very slightly toward the pointer: depth without noise. Off for touch and reduced motion.
function Tilt({ children, className = '', max = 3.5 }) {
  const ref = useRef(null); const reduced = usePrefersReducedMotion();
  const move = (e) => { if (reduced || e.pointerType === 'touch') return; const r = ref.current.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width - 0.5; const y = (e.clientY - r.top) / r.height - 0.5; ref.current.style.transform = `perspective(1100px) rotateX(${(-y * max).toFixed(2)}deg) rotateY(${(x * max).toFixed(2)}deg)`; };
  const leave = () => { if (ref.current) ref.current.style.transform = ''; };
  return <div ref={ref} className={`is-tilt ${className}`} onPointerMove={move} onPointerLeave={leave}>{children}</div>;
}

const Change = ({ c, label }) => {
  if (!c?.available) return <p className="is-compare is-none">{c?.reason ?? 'No comparison yet.'}</p>;
  if (c.change === null) return <p className="is-compare">Up from none the {label}.</p>;
  const up = c.change > 0; const same = c.change === 0;
  return <p className={`is-compare${same ? '' : up ? ' is-up' : ' is-down'}`}><b>{same ? 'No change' : `${up ? '↑' : '↓'} ${Math.abs(c.change)}%`}</b> compared with the previous {label} ({typeof c.previous === 'number' && c.previous > 999 ? inr(c.previous) : c.previous}).</p>;
};

// ---- Section 1: the three numbers ------------------------------------------------------------------------------------------------
function Numbers({ story, days, reduced }) {
  const label = days === 90 ? '3 months' : `${days} days`;
  const money = useCount(story.money.available ? story.money.booked : 0, reduced);
  const orders = useCount(story.orders.value, reduced);
  const wa = story.people.byChannel.whatsapp; // WhatsApp is the only channel shown
  const people = useCount(wa, reduced);
  const m = story.money; const paid = m.available && m.booked > 0 ? Math.min(100, (m.collected / m.booked) * 100) : 0;
  return (
    <section className="is-numbers" aria-label="The business in three numbers">
      <motion.div className="is-n is-money" initial={{ opacity: 0, y: 26 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, ease }}>
        <Tilt>
          <p className="is-label">Total money</p>
          {m.available ? <>
            <p className="is-big"><span className="is-cur">₹</span>{new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(money))}</p>
            <Change c={m.comparison} label={label} />
            <div className="is-collect" role="img" aria-label={`${inr(m.collected)} collected, ${inr(m.outstanding)} still to collect`}>
              <span className="is-bar"><motion.i initial={{ width: 0 }} animate={{ width: `${paid}%` }} transition={{ duration: 1.3, delay: 0.5, ease }} /></span>
              <p><b>{inr(m.collected)}</b> collected <span>·</span> <b className="is-out">{inr(m.outstanding)}</b> still to collect</p>
            </div>
            <p className="is-foot">Booked value of orders received. Collected counts confirmed payments only.{m.unpricedOrders > 0 ? ` ${m.unpricedOrders} ${plural(m.unpricedOrders, 'order has', 'orders have')} no price yet and ${plural(m.unpricedOrders, 'is', 'are')} not included.` : ''}</p>
          </> : <p className="is-empty">{m.reason}</p>}
        </Tilt>
      </motion.div>
      <motion.div className="is-n is-orders" initial={{ opacity: 0, y: 26 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, delay: 0.12, ease }}>
        <Tilt>
          <p className="is-label">Total orders</p>
          <p className="is-big is-mid">{Math.round(orders)}</p>
          <Change c={story.orders.comparison} label={label} />
          <p className="is-foot">Orders received. Drafts and cancelled orders are not counted.</p>
        </Tilt>
      </motion.div>
      <motion.div className="is-n is-people" initial={{ opacity: 0, y: 26 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, delay: 0.24, ease }}>
        <Tilt>
          <p className="is-label">People who contacted</p>
          <p className="is-big is-mid">{Math.round(people)}</p>
          <p className="is-split">{wa} {plural(wa, 'person', 'people')} on WhatsApp</p>
          <Change c={story.people.comparison} label={label} />
          <details className="is-how"><summary>How is this counted?</summary><p>Unique people who sent at least one WhatsApp message in this period. The same number counts once, however many messages it sent.</p></details>
        </Tilt>
      </motion.div>
    </section>
  );
}

// ---- Section 2: the week ---------------------------------------------------------------------------------------------------------
// A smooth monotone curve through the seven daily counts (no overshoot below zero), drawn at the real pixel size of its box so text stays readable on a phone.
function curve(pts) {
  if (pts.length < 2) return '';
  const n = pts.length; const dx = []; const m = []; const t = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; m[i] = (pts[i + 1][1] - pts[i][1]) / dx[i]; }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) { if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; } const a = t[i] / m[i]; const b = t[i + 1] / m[i]; const s = a * a + b * b; if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; } }
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) d += ` C${pts[i][0] + dx[i] / 3},${pts[i][1] + (t[i] * dx[i]) / 3} ${pts[i + 1][0] - dx[i] / 3},${pts[i + 1][1] - (t[i + 1] * dx[i]) / 3} ${pts[i + 1][0]},${pts[i + 1][1]}`;
  return d;
}

function WeekChart({ week, reduced }) {
  const box = useRef(null); const [w, setW] = useState(820); const [active, setActive] = useState(null);
  const inView = useInView(box, { once: true, margin: '-12% 0px' });
  useEffect(() => { const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width)))); ro.observe(box.current); return () => ro.disconnect(); }, []);
  const H = w < 520 ? 300 : 360; const pad = { l: 34, r: 22, t: 34, b: 52 };
  const counts = week.days.map((d) => d.orders); const top = Math.max(3, ...counts); const yMax = top <= 4 ? 4 : Math.ceil(top / 2) * 2;
  const x = (i) => pad.l + 16 + (i * (w - pad.l - pad.r - 32)) / 6; const y = (v) => pad.t + (1 - v / yMax) * (H - pad.t - pad.b);
  const known = week.days.map((d, i) => (d.future ? null : [x(i), y(d.orders)])); const shown = known.filter(Boolean);
  const line = curve(shown); const area = shown.length > 1 ? `${line} L${shown[shown.length - 1][0]},${y(0)} L${shown[0][0]},${y(0)} Z` : '';
  const ticks = Array.from({ length: yMax / (yMax > 8 ? 4 : 2) + 1 }, (_, i) => i * (yMax > 8 ? 4 : 2));
  const near = (clientX) => { const r = box.current.getBoundingClientRect(); const px = clientX - r.left; let b = 0; for (let i = 1; i < 7; i++) if (Math.abs(x(i) - px) < Math.abs(x(b) - px)) b = i; return b; };
  const a = active === null ? null : week.days[active];
  const mob = w < 520;
  return (
    <div className="is-chart" ref={box} onPointerMove={(e) => setActive(near(e.clientX))} onPointerLeave={() => setActive(null)}>
      <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="group" aria-label={`Orders received each day, ${dayShort(week.from)} to ${dayShort(week.to)}`}>
        <defs>
          <linearGradient id="isArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#B9D0F0" stopOpacity="0.55" /><stop offset="100%" stopColor="#B9D0F0" stopOpacity="0" /></linearGradient>
        </defs>
        {ticks.map((t) => <g key={t}><line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} className="is-grid" /><text x={pad.l - 10} y={y(t) + 4} textAnchor="end" className="is-tick">{t}</text></g>)}
        {a && <line x1={x(active)} x2={x(active)} y1={pad.t - 8} y2={y(0)} className="is-guide" />}
        {area && <motion.path d={area} fill="url(#isArea)" initial={{ opacity: 0 }} animate={{ opacity: inView || reduced ? 1 : 0 }} transition={{ duration: 1.2, delay: reduced ? 0 : 0.5 }} />}
        {line && <motion.path d={line} className="is-line" fill="none" initial={{ pathLength: reduced ? 1 : 0 }} animate={{ pathLength: inView || reduced ? 1 : 0 }} transition={{ duration: reduced ? 0 : 1.6, ease }} />}
        {week.days.map((d, i) => (
          <g key={d.date}>
            <text x={x(i)} y={H - 20} textAnchor="middle" className={`is-day${active === i ? ' is-on' : ''}`}>{mob ? d.weekday.slice(0, 1) : d.weekday.slice(0, 3)}</text>
            {!d.future && <motion.circle cx={x(i)} cy={y(d.orders)} r={active === i ? 7 : 4.5} className={`is-dot${active === i ? ' is-on' : ''}`} initial={{ opacity: 0, scale: 0.4 }} animate={{ opacity: inView || reduced ? 1 : 0, scale: 1 }} transition={{ duration: 0.5, delay: reduced ? 0 : 0.7 + i * 0.12 }} style={{ transformOrigin: `${x(i)}px ${y(d.orders)}px` }} />}
            <rect x={x(i) - 26} y={pad.t - 10} width={52} height={H - pad.t - pad.b + 24} fill="transparent" tabIndex={0} role="img" aria-label={d.future ? `${d.weekday}: not yet` : `${d.weekday} ${dayShort(d.date)}: ${d.orders} ${plural(d.orders, 'order', 'orders')}`} onFocus={() => setActive(i)} onBlur={() => setActive(null)} className="is-hit" />
          </g>
        ))}
      </svg>
      {a && <div className="is-tip" style={{ left: Math.min(w - 90, Math.max(90, x(active))), top: a.future ? y(0) - 70 : Math.max(8, y(a.orders) - 74) }} role="status"><b>{a.future ? '—' : a.orders}</b><span>{a.future ? `${a.weekday}, not yet` : `${plural(a.orders, 'order', 'orders')} · ${dayLong(a.date)}`}</span></div>}
    </div>
  );
}

function Week({ week, onWeek, reduced }) {
  return (
    <section className="is-week" aria-labelledby="is-week-h">
      <div className="is-week-head">
        <div>
          <h2 id="is-week-h">Your business, <em>this week.</em></h2>
          <p>Every order tells a little more about your rhythm.</p>
        </div>
        <div className="is-weeknav" role="group" aria-label="Choose a week">
          <button type="button" onClick={() => onWeek(week.prev)} aria-label="Previous week">←</button>
          <span>{dayShort(week.from)} – {dayShort(week.to)}<small>{week.total} {plural(week.total, 'order', 'orders')}{week.isCurrent ? ' · this week' : ''}</small></span>
          <button type="button" onClick={() => onWeek(week.next)} disabled={!week.next} aria-label="Next week">→</button>
        </div>
      </div>
      <WeekChart week={week} reduced={reduced} />
      <ul className="sr-only">{week.days.map((d) => <li key={d.date}>{d.weekday}: {d.future ? 'not yet' : `${d.orders} ${plural(d.orders, 'order', 'orders')}`}</li>)}</ul>
    </section>
  );
}

// ---- Section 3: three discoveries ------------------------------------------------------------------------------------------------
const Reveal = ({ children, className, delay = 0 }) => <motion.article className={className} initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '-10% 0px' }} transition={{ duration: 0.8, delay, ease }}>{children}</motion.article>;

function Highlights({ story, label }) {
  const { popular: p, busiest: b, regular: r } = story;
  return (
    <section className="is-found" aria-label="Three things worth knowing">
      <Reveal className="is-card is-pop">
        <Tilt max={2.5}>
          <div className="is-pop-grid">
            <div className={`is-pic${p.available && p.image ? '' : ' is-noimg'}`}>{p.available && p.image ? <img src={attachmentSrc(p.image)} alt={`A ${p.product.toLowerCase()} order`} loading="lazy" /> : <span aria-hidden="true">{p.available ? p.product.charAt(0) : '·'}</span>}</div>
            <div className="is-pop-text">
              <p className="is-kick">Most popular order</p>
              <h3>The crowd <em>favourite.</em></h3>
              {p.available ? <>
                <p className="is-name">{p.product}</p>
                <p className="is-stat"><b>{p.orders}</b> {plural(p.orders, 'order', 'orders')} <span>·</span> <b>{p.units}</b> {plural(p.units, 'unit', 'units')}</p>
                <p className="is-note">{p.repeats ? `${p.share}% of the orders in the last ${label}.` : p.tiedOnOrders > 1 ? `Every product was ordered once in the last ${label}; this one leads on quantity.` : `Ordered once in the last ${label}.`}</p>
              </> : <p className="is-empty">{p.reason}</p>}
            </div>
          </div>
        </Tilt>
      </Reveal>
      <div className="is-found-side">
        <Reveal className="is-card is-busy" delay={0.1}>
          <p className="is-kick">Busiest days</p>
          <h3>Your busiest <em>rhythm.</em></h3>
          {b.available ? <>
            <p className="is-day-big">{b.weekday}{b.ties > 1 ? <small> and {b.ties - 1} more</small> : null}</p>
            <p className="is-stat"><b>{b.orders}</b> {plural(b.orders, 'order', 'orders')} <span>·</span> out of {b.total}</p>
            <div className="is-mini" role="img" aria-label={b.perWeekday.map((d) => `${d.weekday} ${d.orders}`).join(', ')}>{b.perWeekday.map((d) => <span key={d.weekday} className={d.orders === b.orders ? 'is-hi' : ''}><i style={{ height: `${Math.max(6, (d.orders / b.orders) * 100)}%` }} /><em>{d.weekday.slice(0, 1)}</em></span>)}</div>
            {b.quietest && <p className="is-note">Quietest: {b.quietest.weekday}, {b.quietest.orders} {plural(b.quietest.orders, 'order', 'orders')}.</p>}
          </> : <p className="is-empty">{b.reason}</p>}
        </Reveal>
        <Reveal className="is-card is-reg" delay={0.2}>
          <p className="is-kick">Most regular customer</p>
          <h3>A familiar <em>face.</em></h3>
          {r.available ? <div className="is-reg-body">
            <div className="is-mono" aria-hidden="true"><span>{r.name.trim().charAt(0).toUpperCase()}</span><i /></div>
            <div><p className="is-name">{r.name}</p><p className="is-stat"><b>{r.orders}</b> orders</p><p className="is-note">Last ordered {new Date(r.lastOrderAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}. {r.basis === 'name' ? 'Matched by name, as no contact is recorded.' : 'Matched by contact.'}</p></div>
          </div> : <p className="is-empty">{r.reason}</p>}
        </Reveal>
      </div>
    </section>
  );
}

export default function Analytics() {
  const [params, setParams] = useSearchParams();
  const rangeP = Number(params.get('range')); const days = [7, 30, 90].includes(rangeP) ? rangeP : 7;
  const weekP = /^\d{4}-\d{2}-\d{2}$/.test(params.get('week') ?? '') ? params.get('week') : undefined;
  const reduced = usePrefersReducedMotion();
  const { status, data, error, reload } = useAsync(() => getInsights(days, 'all', weekP), [days, weekP]);
  useLive(['orders', 'payments', 'messages'], reload);
  const setP = (changes) => setParams((p) => { const n = new URLSearchParams(p); Object.entries(changes).forEach(([k, v]) => (v == null ? n.delete(k) : n.set(k, v))); return n; }, { replace: true });
  const story = data?.story;
  const label = days === 90 ? '3 months' : `${days} days`;

  return (
    <section className="page insights is-page">
      <header className="is-hero">
        <motion.div className="is-hero-text" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.9, ease }}>
          <p className="is-eyebrow">Insights</p>
          <h1>How your<br />business <em>is doing.</em></h1>
          <div className="is-range" role="group" aria-label="Reporting period">
            {RANGES.map(([d, l]) => <button key={d} type="button" className={days === d ? 'is-on' : ''} aria-pressed={days === d} onClick={() => setP({ range: d === 7 ? null : d })}>{l}</button>)}
          </div>
        </motion.div>
      </header>

      {status === 'error' && <StateMessage kind="error" message={`Couldn't load Insights. ${error.message}`} onRetry={reload} />}
      {!story && status !== 'error' && <StateMessage kind="loading" message="Reading your orders…" />}
      {story && (
        <div className="is-body">
          <Numbers story={story} days={days} reduced={reduced} />
          <Week week={story.week} onWeek={(w) => w && setP({ week: w })} reduced={reduced} />
          <Highlights story={story} label={label} />
        </div>
      )}
    </section>
  );
}
