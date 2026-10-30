import { useEffect, useId, useRef, useState } from 'react';

// Small SVG charts for the Insights dashboard, drawn from real numbers only. No chart library is installed in this project, so these are
// plain React + SVG: scaled axes, gridlines, a combined bar + line chart with two axes and a tooltip, donuts, and sparklines.

export const INK = '#243F73';      // navy
export const CARAMEL = '#C58A52';
export const SOFT = { blue: '#A9C9EE', green: '#9CC59A', peach: '#F0C7A4', navy: '#243F73', grey: '#D9D4CA' };

// Width of a container, kept up to date (so charts can be drawn at their real pixel size and stay crisp).
export function useWidth() {
  const ref = useRef(null); const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current; if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width))); ro.observe(el); setW(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// A "nice" axis: the smallest round maximum above the data, with 4 even steps.
export function niceScale(max, steps = 4, whole = false) {
  if (!(max > 0)) return { max: steps, step: 1 };
  const raw = max / steps; const pow = 10 ** Math.floor(Math.log10(raw)); const f = raw / pow;
  let step = (f <= 1 ? 1 : f <= 1.5 ? 1.5 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
  if (whole) step = Math.max(1, Math.ceil(step)); // counts of orders: the axis only ever shows whole numbers
  return { max: step * steps, step };
}
export const compact = (n) => (n >= 1e7 ? `${+(n / 1e7).toFixed(1)}Cr` : n >= 1e5 ? `${+(n / 1e5).toFixed(1)}L` : n >= 1e3 ? `${+(n / 1e3).toFixed(n % 1e3 ? 1 : 0)}K` : String(Math.round(n * 100) / 100));

// ---- Combined chart: bars (left axis) and a line (right axis) over the same dates -------------------------------------------
// points: [{ label, full, bar, line }]. Either series can be turned off with `show`.
export function ComboChart({ points, show = { bar: true, line: true }, barName, lineName, fmtBar, fmtLine, tickBar = compact, height = 300, barColor = CARAMEL, lineColor = INK, ariaLabel }) {
  const [ref, width] = useWidth(); const [hover, setHover] = useState(null); const uid = useId().replace(/:/g, '');
  const m = { l: show.bar ? 56 : 16, r: show.line ? 40 : 16, t: 14, b: 34 }; // margins: room for the axes' numbers
  const W = Math.max(width, 280); const iw = W - m.l - m.r; const ih = height - m.t - m.b;
  const n = points.length; const slot = iw / Math.max(n, 1);
  const bScale = niceScale(Math.max(...points.map((p) => p.bar ?? 0), 0)); const lScale = niceScale(Math.max(...points.map((p) => p.line ?? 0), 0), 4, true);
  const gridMax = show.bar ? bScale : lScale; // gridlines follow the left axis (or the right one when only the line shows)
  const y = (v, sc) => m.t + ih - (v / sc.max) * ih;
  const x = (i) => m.l + slot * i + slot / 2;
  const barW = Math.min(34, Math.max(3, slot * 0.58));
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 62)))); // thin out date labels so they never collide
  const line = show.line ? points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.line, lScale).toFixed(1)}`).join(' ') : '';
  const area = show.line && n > 1 ? `${line} L${x(n - 1).toFixed(1)} ${m.t + ih} L${x(0).toFixed(1)} ${m.t + ih} Z` : '';
  const hp = hover === null ? null : points[hover];
  const tipX = hover === null ? 0 : Math.min(Math.max(x(hover), 84), W - 84);

  return (
    <div className="ch" ref={ref} style={{ height }} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={W} height={height} role="img" aria-label={ariaLabel}>
          <defs><linearGradient id={`bar-${uid}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={barColor} /><stop offset="1" stopColor={barColor} stopOpacity="0.72" /></linearGradient>
            <linearGradient id={`area-${uid}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={lineColor} stopOpacity="0.12" /><stop offset="1" stopColor={lineColor} stopOpacity="0" /></linearGradient></defs>
          {Array.from({ length: 5 }, (_, k) => { const v = (gridMax.step * k); const yy = y(v, gridMax); return (
            <g key={k}><line x1={m.l} x2={W - m.r} y1={yy} y2={yy} className="ch-grid" />
              {show.bar && <text x={m.l - 10} y={yy + 4} textAnchor="end" className="ch-axis">{k === 0 ? '0' : tickBar(v)}</text>}
              {show.line && <text x={W - m.r + 10} y={y(lScale.step * k, lScale) + 4} textAnchor="start" className="ch-axis">{compact(lScale.step * k)}</text>}
            </g>); })}
          {show.bar && points.map((p, i) => p.bar > 0 && <rect key={i} x={x(i) - barW / 2} y={y(p.bar, bScale)} width={barW} height={m.t + ih - y(p.bar, bScale)} rx={Math.min(6, barW / 2)} fill={`url(#bar-${uid})`} className={`ch-bar${hover === i ? ' is-hover' : ''}`} />)}
          {area && <path d={area} fill={`url(#area-${uid})`} />}
          {show.line && <path d={line} fill="none" stroke={lineColor} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" className="ch-line" />}
          {show.line && points.map((p, i) => (n <= 31 || hover === i) && <circle key={i} cx={x(i)} cy={y(p.line, lScale)} r={hover === i ? 5 : 3.4} fill="#fff" stroke={lineColor} strokeWidth="2.2" />)}
          {points.map((p, i) => i % every === 0 && <text key={i} x={x(i)} y={height - 10} textAnchor="middle" className="ch-axis">{p.label}</text>)}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={m.t} y2={m.t + ih} className="ch-cursor" />}
          {points.map((p, i) => <rect key={i} x={m.l + slot * i} y={m.t} width={slot} height={ih} fill="transparent" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onTouchStart={() => setHover(i)} />)}
        </svg>
      )}
      {hp && (
        <div className="ch-tip" style={{ left: tipX, top: 8 }} role="status">
          <b>{hp.full}</b>
          {show.bar && <span><i style={{ background: barColor }} />{barName}<em>{fmtBar(hp.bar)}</em></span>}
          {show.line && <span><i style={{ background: lineColor }} />{lineName}<em>{fmtLine(hp.line)}</em></span>}
        </div>
      )}
    </div>
  );
}

// ---- Donut -----------------------------------------------------------------------------------------------------------------
// slices: [{ key, label, value, color }]. Slices with 0 are not drawn. `center` is HTML-free text drawn in the hole.
export function Donut({ slices, size = 136, thickness = 18, centerTop, centerBottom, ariaLabel }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  const r = (size - thickness) / 2; const c = size / 2; const circ = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={ariaLabel} className="ch-donut">
      <circle cx={c} cy={c} r={r} fill="none" stroke="#EFEBE3" strokeWidth={thickness} />
      {total > 0 && slices.filter((s) => s.value > 0).map((s) => {
        const len = (s.value / total) * circ; const gap = slices.filter((x) => x.value > 0).length > 1 ? Math.min(3, len * 0.2) : 0;
        const el = <circle key={s.key} cx={c} cy={c} r={r} fill="none" stroke={s.color} strokeWidth={thickness} strokeDasharray={`${Math.max(len - gap, 0.5)} ${circ - Math.max(len - gap, 0.5)}`} strokeDashoffset={-offset} transform={`rotate(-90 ${c} ${c})`} strokeLinecap="butt" className="ch-slice" />;
        offset += len; return el;
      })}
      <text x={c} y={c - 2} textAnchor="middle" className="ch-center">{centerTop}</text>
      <text x={c} y={c + 20} textAnchor="middle" className="ch-center-sub">{centerBottom}</text>
    </svg>
  );
}

// ---- Sparkline -------------------------------------------------------------------------------------------------------------
// values: numbers or null (a gap). Needs at least 2 real values, otherwise nothing is drawn (never a fake flat line).
export function Sparkline({ values, color = INK, width = 112, height = 36 }) {
  const uid = useId().replace(/:/g, '');
  const real = values.filter((v) => v !== null);
  if (real.length < 2) return null;
  const max = Math.max(...real); const min = Math.min(...real); const span = max - min || 1;
  const px = (i) => 2 + (i / (values.length - 1)) * (width - 4);
  const py = (v) => height - 4 - ((v - min) / span) * (height - 8);
  const pts = values.map((v, i) => (v === null ? null : [px(i), py(v)])).filter(Boolean);
  const d = pts.map(([a, b], i) => `${i ? 'L' : 'M'}${a.toFixed(1)} ${b.toFixed(1)}`).join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="ch-spark">
      <defs><linearGradient id={`sp-${uid}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity="0.2" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      <path d={`${d} L${pts.at(-1)[0].toFixed(1)} ${height} L${pts[0][0].toFixed(1)} ${height} Z`} fill={`url(#sp-${uid})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts.at(-1)[0]} cy={pts.at(-1)[1]} r="2.6" fill={color} />
    </svg>
  );
}
