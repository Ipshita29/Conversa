import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { greeting } from '../utils/format.js';
import DemoBadge from './DemoBadge.jsx';

const REVEAL_RADIUS = 260; // px radius of the vivid spotlight (capped at a fraction of the viewport); the feathered edge is --f in Dashboard.css
const FOLLOW = 0.22;       // 0..1, how quickly the reveal catches up with the pointer
const GROW_MS = 400;       // the spotlight opens from a small circle to full size, and collapses, over this long
const START_R = 36;        // px radius it opens from
const easeOut = (t) => 1 - (1 - t) ** 3;

// Cursor-following reveal. The hero shows a muted, cream-washed photo; the vivid original appears around the pointer through a
// feathered radial mask. Pointer tracking runs on requestAnimationFrame only while something is still moving, uses the page's
// native scroll position (so Lenis smooth-scrolling and the reveal never interfere), and is switched off for reduced motion.
function useHoverReveal(sectionRef, bgRef) {
  useEffect(() => {
    const section = sectionRef.current?.closest('#overview') ?? sectionRef.current;
    const bg = bgRef.current;
    if (!section || !bg) return undefined;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const set = (x, y, r) => { bg.style.setProperty('--mx', `${x.toFixed(1)}px`); bg.style.setProperty('--my', `${y.toFixed(1)}px`); bg.style.setProperty('--r', `${r.toFixed(1)}px`); };
    const maxR = () => Math.min(REVEAL_RADIUS, window.innerWidth * 0.34);
    const st = { x: 0, y: 0, r: 0, tx: 0, ty: 0, tr: 0, from: 0, t0: 0, cx: null, cy: null, raf: 0 };
    const retarget = (tr) => { st.from = st.r; st.tr = tr; st.t0 = performance.now(); };

    const touch = window.matchMedia('(hover: none)');
    if (reduced.matches || touch.matches) { // no tracking: a still reveal. Touch screens get a wide, gently blended one; reduced motion a softer one.
      const rect = () => { const b = bg.getBoundingClientRect(); set(b.width * 0.7, b.height * 0.48, touch.matches ? Math.max(b.width, b.height) * 0.85 : maxR() * 0.9); };
      rect(); window.addEventListener('resize', rect);
      return () => window.removeEventListener('resize', rect);
    }

    const toLocal = () => { const b = bg.getBoundingClientRect(); st.tx = st.cx - b.left; st.ty = st.cy - b.top; };
    const frame = (now) => {
      st.raf = 0;
      if (st.cx !== null) toLocal();
      st.x += (st.tx - st.x) * FOLLOW; st.y += (st.ty - st.y) * FOLLOW;
      const k = Math.min(1, (now - st.t0) / GROW_MS);
      st.r = st.from + (st.tr - st.from) * easeOut(k);
      set(st.x, st.y, st.r);
      const moving = k < 1 || Math.abs(st.tx - st.x) > 0.3 || Math.abs(st.ty - st.y) > 0.3;
      if (moving) st.raf = requestAnimationFrame(frame);
    };
    const kick = () => { if (!st.raf) st.raf = requestAnimationFrame(frame); };
    const onMove = (e) => {
      const opening = st.cx === null || st.tr === 0;
      st.cx = e.clientX; st.cy = e.clientY;
      if (opening) { toLocal(); st.x = st.tx; st.y = st.ty; st.r = Math.min(st.r, START_R); retarget(maxR()); } // open from a small circle where the pointer entered
      kick();
    };
    const onLeave = () => { retarget(0); kick(); };
    const onScroll = () => { if (st.cx !== null && st.tr > 0) kick(); }; // keep the reveal under a still pointer while the page scrolls
    const onDown = (e) => { if (e.pointerType !== 'mouse') onMove(e); };
    section.addEventListener('pointermove', onMove, { passive: true });
    section.addEventListener('pointerdown', onDown, { passive: true });
    section.addEventListener('pointerleave', onLeave);
    section.addEventListener('pointercancel', onLeave);
    section.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') onLeave(); });
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    // Before any pointer arrives (and on touch screens) a small reveal rests at the right, so the vivid photo is visible.
    const b0 = bg.getBoundingClientRect(); st.x = st.tx = b0.width * 0.74; st.y = st.ty = b0.height * 0.46; st.r = st.tr = st.from = 0; set(st.x, st.y, 0);
    return () => {
      cancelAnimationFrame(st.raf);
      section.removeEventListener('pointermove', onMove); section.removeEventListener('pointerdown', onDown);
      section.removeEventListener('pointerleave', onLeave); section.removeEventListener('pointercancel', onLeave);
      window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll);
    };
  }, [sectionRef, bgRef]);
}

export default function HeroSection({ stats, attention }) {
  const rootRef = useRef(null);
  const bgRef = useRef(null);
  useHoverReveal(rootRef, bgRef);
  const now = new Date();
  const open = stats ? stats.pending + stats.inProgress : null;
  return (
    <div className="hero" ref={rootRef}>
      <div className="hero-copy">
      <div className="hero-meta">
        <p className="eyebrow">Business operations, made clear</p>
        <DemoBadge />
      </div>
      <p className="hero-greeting">{greeting(now)} · {now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      <h1><span className="hero-line">Your business,</span> <span className="hero-line">in better rhythm.</span></h1>
      <p className="hero-lede">Every order, every deadline, every conversation — thoughtfully brought together in one place.</p>
      <div className="hero-actions">
        <Link to="/plan" className="btn btn-primary">Review today's orders <ArrowRight size={16} aria-hidden="true" /></Link>
        {stats && <p className="hero-summary">{stats.total} {stats.total === 1 ? 'order' : 'orders'} · {open} open · {attention ?? stats.atRisk} {(attention ?? stats.atRisk) === 1 ? 'needs' : 'need'} attention</p>}
      </div>
      <p className="hero-statement"><span>The AI reads.</span> <span>Rules decide.</span> <span>You approve.</span></p>
      </div>
      <div className="hero-bg" ref={bgRef} aria-hidden="true">
        <img className="hero-bg-muted" src="/hero.png" alt="" decoding="async" fetchpriority="high" />
        <span className="hero-bg-scrim" />
        <img className="hero-bg-vivid" src="/hero.png" alt="" decoding="async" />
      </div>
    </div>
  );
}
