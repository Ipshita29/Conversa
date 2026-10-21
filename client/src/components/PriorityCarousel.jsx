import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react';
import { formatInTz, formatMinutes, isDemoOrder } from '../utils/format.js';
import SectionHead from './SectionHead.jsx';
import StateMessage from './StateMessage.jsx';
import { RiskBadge } from './Badge.jsx';
import '../css/Carousel.css';

const RISK_OF = { deadline_passed: 'high', unschedulable: 'high', late: 'high', tight: 'medium', on_track: 'low' };
const plural = (n, one, many) => (n === 1 ? one : many);
const PROPS_OK = typeof CSS !== 'undefined' && 'registerProperty' in CSS; // animated card sizes need registered custom properties

// How much time is left (or how overdue the order is), measured at the moment the scheduler produced its plan.
function timing(order, nowIso) {
  if (!order.deadline) return { label: 'No deadline set', tone: 'none' };
  const mins = Math.round((Date.parse(order.deadline) - Date.parse(nowIso ?? new Date().toISOString())) / 60000);
  return mins < 0 ? { label: `Overdue by ${formatMinutes(-mins)}`, tone: 'overdue' } : { label: `${formatMinutes(mins)} left`, tone: 'ok' };
}

// Priority cards for the homepage. Rank, action, explanation and risk all come from the scheduling engine (planner.nextMoves),
// the same source as the Deadlines timeline. The ACTIVE card is always the largest; the ones after it step down in size.
//
// Layout stays stable on purpose: the active card is pinned to the left edge and the track slides by exactly the width the
// cards before it will have. Card width and the slide use the same duration and easing, so both stay in step (no jumps, no clipping).
export default function PriorityCarousel({ planner, orders }) {
  const tz = planner.range.timezone;
  const byId = Object.fromEntries(orders.map((o) => [o.id, o]));
  const moves = (planner.nextMoves ?? []).filter((m) => byId[m.orderId]);
  const n = moves.length;
  const viewportRef = useRef(null);
  const trackRef = useRef(null);
  const probeRef = useRef(null);
  const gesture = useRef({ acc: 0, lockUntil: 0, startX: null, dx: 0, dragged: false });
  const focusAfter = useRef(false);
  const [active, setActive] = useState(0);
  const [step, setStep] = useState(272); // width of a smallest card + the gap: how far one position slides the track
  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);

  const to = useCallback((i) => setActive((a) => Math.max(0, Math.min(n - 1, typeof i === 'function' ? i(a) : i))), [n]);
  useEffect(() => { if (active > n - 1) setActive(Math.max(0, n - 1)); }, [n, active]);

  // Measure the smallest card (a hidden probe, so it reflects the current breakpoint) plus the gap.
  useLayoutEffect(() => {
    const measure = () => {
      if (!probeRef.current || !trackRef.current) return;
      setStep(probeRef.current.offsetWidth + (parseFloat(getComputedStyle(trackRef.current).columnGap) || 0));
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (viewportRef.current) ro?.observe(viewportRef.current);
    return () => ro?.disconnect();
  }, [n]);

  // Horizontal trackpad gestures step the carousel. Vertical wheel movement is left alone, so the page (and Lenis) scroll normally.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault(); // also stops the browser's back/forward swipe
      const g = gesture.current;
      const now = performance.now();
      if (now < g.lockUntil) { if (Math.abs(e.deltaX) > 4) g.lockUntil = Math.max(g.lockUntil, now + 140); return; } // let one swipe's momentum die out
      g.acc += e.deltaX;
      if (Math.abs(g.acc) >= 50) { to((a) => a + Math.sign(g.acc)); g.acc = 0; g.lockUntil = now + 480; }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [to]);

  // Touch and mouse dragging.
  const onPointerDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    gesture.current.startX = e.clientX; gesture.current.dx = 0; gesture.current.dragged = false;
  };
  const onPointerMove = (e) => {
    const g = gesture.current;
    if (g.startX === null) return;
    g.dx = e.clientX - g.startX;
    if (!g.dragged && Math.abs(g.dx) > 8) { g.dragged = true; setDragging(true); e.currentTarget.setPointerCapture?.(e.pointerId); }
    if (g.dragged) setDrag(Math.max(-step * 0.6, Math.min(step * 0.6, g.dx)));
  };
  const endDrag = () => {
    const g = gesture.current;
    if (g.startX === null) return;
    if (g.dragged && Math.abs(g.dx) > 45) to((a) => a - Math.sign(g.dx));
    g.startX = null; setDrag(0); setDragging(false);
    setTimeout(() => { g.dragged = false; }, 0);
  };
  const onClickCapture = (e) => { if (gesture.current.dragged) { e.preventDefault(); e.stopPropagation(); } }; // a swipe must not open an order

  const stepBy = (dir, keepFocus = false) => { focusAfter.current = keepFocus; to((a) => a + dir); };
  const onKey = (e) => {
    const keys = { ArrowRight: 1, ArrowLeft: -1 };
    if (e.key in keys) { e.preventDefault(); stepBy(keys[e.key], viewportRef.current.contains(document.activeElement) && document.activeElement !== viewportRef.current); }
    else if (e.key === 'Home') { e.preventDefault(); to(0); } else if (e.key === 'End') { e.preventDefault(); to(n - 1); }
  };
  useEffect(() => { // after a keyboard step, keep keyboard focus on the new active card
    if (focusAfter.current) { focusAfter.current = false; trackRef.current?.children[active]?.querySelector('a')?.focus({ preventScroll: true }); }
  }, [active]);

  const subtitle = "The few orders closest to trouble. Here's what to do, and why.";
  if (!Array.isArray(planner.nextMoves)) {
    return <><SectionHead eyebrow="Urgent" title="What needs you first.">{subtitle}</SectionHead><StateMessage kind="error" message="Your server is running an older version of the scheduler, so it can't rank your orders. Restart it with npm run dev in the server folder." /></>;
  }

  return (
    <>
      <SectionHead eyebrow="Urgent" title="What needs you first.">{subtitle}</SectionHead>
      {n === 0 ? <StateMessage message="Nothing is waiting on you right now." /> : (
        <div className={`pc${PROPS_OK ? '' : ' pc-static'}`}>
          <div className="pc-bar">
            <p className="pc-count" aria-live="polite"><b>{n}</b> actionable {plural(n, 'order', 'orders')} · showing priority <b>{active + 1}</b> of {n}</p>
            <div className="pc-nav">
              <Link to="/deadlines" className="pc-timeline">See full timeline <ArrowRight size={14} aria-hidden="true" /></Link>
              <button type="button" className="pc-arrow" onClick={() => stepBy(-1)} disabled={active === 0} aria-label="Previous priority"><ChevronLeft size={20} aria-hidden="true" /></button>
              <button type="button" className="pc-arrow" onClick={() => stepBy(1)} disabled={active >= n - 1} aria-label="Next priority"><ChevronRight size={20} aria-hidden="true" /></button>
            </div>
          </div>

          <div className="pc-viewport" ref={viewportRef} tabIndex={0} role="region" aria-roledescription="carousel" aria-label="Priority orders, most urgent first. Use the left and right arrow keys to browse."
            onKeyDown={onKey} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} onClickCapture={onClickCapture}>
            <ol className={`pc-track${dragging ? ' is-dragging' : ''}`} ref={trackRef} style={{ transform: `translate3d(${drag - active * step}px, 0, 0)` }}>
              {moves.map((m, i) => {
                const o = byId[m.orderId];
                const t = timing(o, planner.generatedAt);
                const blocked = m.kind === 'needs_details';
                const tier = i < active ? 4 : Math.min(i - active + 1, 4); // 1 = active (largest) ... 4 = smallest
                return (
                  <li key={m.orderId} className={`pc-card pc-t${tier}${tier === 1 ? ' is-active' : ''}`} aria-label={`Priority ${m.rank} of ${n}`} onFocusCapture={() => to(i)}>
                    <span className="pc-rank" aria-hidden="true">{m.rank}</span>
                    <h3 className="pc-action"><Link className="pc-link" to={`/orders?edit=${o.id}`} title={m.action}>{m.action}</Link></h3>
                    <p className="pc-who"><strong>{o.customerName}</strong> · {o.item}{o.quantity > 1 ? ` × ${o.quantity}` : ''}</p>
                    <p className={`pc-when pc-${t.tone}`}><b>{t.label}</b><span>{o.deadline ? `Due ${formatInTz(o.deadline, tz)} · ` : ''}{o.prepTimeMinutes === null ? 'prep time not set' : `${formatMinutes(o.prepTimeMinutes)} prep`}</span></p>
                    <div className="pc-risk"><RiskBadge risk={RISK_OF[m.kind]} needsDetails={blocked} /></div>
                    <p className="pc-why" title={m.why}>{m.why}</p>
                    <div className="pc-foot">
                      <span className="pc-cta">{blocked ? 'Update order' : 'View order'} <ArrowRight size={14} aria-hidden="true" /></span>
                      {isDemoOrder(o) && <span className="demo-tag">Demo</span>}
                    </div>
                  </li>
                );
              })}
            </ol>
            <span className="pc-card pc-t4 pc-probe" ref={probeRef} aria-hidden="true" />
          </div>
        </div>
      )}
    </>
  );
}
