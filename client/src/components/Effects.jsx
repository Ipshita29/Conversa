import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { DEMO_MODE } from '../services/api.js';
import { ReactLenis, useLenis } from 'lenis/react';
import usePrefersReducedMotion from '../hooks/usePrefersReducedMotion.js';
import { registerLenis, scrollToTop, scrollToSection } from '../utils/scroll.js';
import { updateParallax, clearParallax } from '../utils/parallax.js';
import { DemoBadge } from './UI.jsx';

// ---------- HeroSection ----------
const RADIUS = 320;   // px: the reveal's full reach. Its edge falls off gradually (see the mask in Dashboard.css), so no boundary is visible.
const FOLLOW = 0.075; // 0..1 per frame, how quickly the reveal drifts after the pointer: small = slow and fluid
const FADE = 0.06;    // 0..1 per frame, how quickly it fades in on entry and back out on exit

// Cursor-following reveal. The hero shows a muted, cream-washed photo; the full-colour original is uncovered around the pointer through
// a wide, feathered radial mask. Position and strength are eased towards their targets on requestAnimationFrame (running only while
// something is still moving) and written straight to CSS variables, so React never re-renders on pointer movement. Coordinates are relative
// to the hero. Touch screens and reduced motion get a still, faint reveal and no tracking.
function useHoverReveal(sectionRef, bgRef) {
  useEffect(() => {
    const section = sectionRef.current?.closest('#overview') ?? sectionRef.current;
    const bg = bgRef.current;
    if (!section || !bg) return undefined;
    const set = (x, y, o) => { bg.style.setProperty('--mx', `${x.toFixed(1)}px`); bg.style.setProperty('--my', `${y.toFixed(1)}px`); bg.style.setProperty('--o', o.toFixed(3)); };
    const radius = () => Math.min(RADIUS, window.innerWidth * 0.42);
    const applyRadius = () => bg.style.setProperty('--r', `${radius()}px`);
    applyRadius();

    const still = window.matchMedia('(hover: none), (prefers-reduced-motion: reduce)');
    if (still.matches) {
      const rest = () => { const b = bg.getBoundingClientRect(); set(b.width * 0.72, b.height * 0.5, 0.45); applyRadius(); };
      rest(); window.addEventListener('resize', rest);
      return () => window.removeEventListener('resize', rest);
    }

    const b0 = bg.getBoundingClientRect();
    const st = { x: b0.width * 0.72, y: b0.height * 0.5, tx: b0.width * 0.72, ty: b0.height * 0.5, o: 0, to: 0, cx: null, cy: null, raf: 0 };
    const target = () => { const b = bg.getBoundingClientRect(); st.tx = st.cx - b.left; st.ty = st.cy - b.top; }; // re-read each frame so scrolling keeps it under the pointer
    const frame = () => {
      st.raf = 0;
      if (st.cx !== null) target();
      st.x += (st.tx - st.x) * FOLLOW; st.y += (st.ty - st.y) * FOLLOW; st.o += (st.to - st.o) * FADE;
      set(st.x, st.y, st.o);
      if (Math.abs(st.tx - st.x) > 0.3 || Math.abs(st.ty - st.y) > 0.3 || Math.abs(st.to - st.o) > 0.004) st.raf = requestAnimationFrame(frame);
    };
    const kick = () => { if (!st.raf) st.raf = requestAnimationFrame(frame); };
    const onMove = (e) => {
      if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
      if (st.cx === null || st.to === 0) { st.cx = e.clientX; st.cy = e.clientY; target(); st.x = st.tx; st.y = st.ty; } // first entry: appear under the pointer, don't fly in
      st.cx = e.clientX; st.cy = e.clientY; st.to = 1; kick();
    };
    const onLeave = () => { st.to = 0; st.cx = null; kick(); }; // fades out in place
    const onScroll = () => { if (st.cx !== null) kick(); };
    section.addEventListener('pointermove', onMove, { passive: true });
    section.addEventListener('pointerleave', onLeave);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', applyRadius);
    set(st.x, st.y, 0);
    return () => {
      cancelAnimationFrame(st.raf);
      section.removeEventListener('pointermove', onMove); section.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', applyRadius);
    };
  }, [sectionRef, bgRef]);
}

export function HeroSection({ stats, attention }) {
  const needs = attention ?? stats?.atRisk;
  const rootRef = useRef(null);
  const bgRef = useRef(null);
  useHoverReveal(rootRef, bgRef);
  return (
    <div className="hero" ref={rootRef}>
      <div className="hero-copy">
        <div className="hero-meta">
          <p className="eyebrow">Less chaos. More clarity.</p>
          <DemoBadge />
        </div>
        <h1><span className="hero-line">Every order,</span> <span className="hero-line">under control.</span></h1>
        <p className="hero-lede">From the first customer message to the final delivery, keep every order and deadline in one place.</p>
        <div className="hero-actions">
          <Link to="/orders" className="btn btn-primary">Explore your orders <ArrowRight size={16} aria-hidden="true" /></Link>
          {stats && <p className="hero-summary">{stats.total} {DEMO_MODE ? 'demo ' : ''}{stats.total === 1 ? 'order' : 'orders'} · {needs} {needs === 1 ? 'needs' : 'need'} attention</p>}
        </div>
        <p className="hero-trust">AI helps organise. You stay in control.</p>
      </div>
      <div className="hero-bg" ref={bgRef} aria-hidden="true">
        <img className="hero-bg-muted" src="/hero.png" alt="" decoding="async" fetchpriority="high" />
        <span className="hero-bg-scrim" />
        <img className="hero-bg-vivid" src="/hero.png" alt="" decoding="async" />
      </div>
    </div>
  );
}

// ---------- Reveal ----------
// Fades/lifts its children in once, when scrolled into view (from="right": the section heading slides in from the right). Shows immediately if IntersectionObserver is unavailable.
export function Reveal({ as: Tag = 'div', className = '', from, children, ...rest }) {
  const ref = useRef(null);
  const [shown, setShown] = useState(typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    if (shown || !ref.current) return undefined;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setShown(true); io.disconnect(); } }, { threshold: 0.05 });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [shown]);

  return <Tag ref={ref} className={`reveal${from === 'right' ? ' reveal--right' : ''}${shown ? ' is-visible' : ''} ${className}`.trim()} {...rest}>{children}</Tag>;
}

// ---------- SmoothScroll ----------
// Exposes the Lenis instance to scrollToSection(), resets to the top on new pages,
// and publishes the smoothed scroll progress + parallax on every frame.
function Bridge() {
  const setProgress = (p) => document.documentElement.style.setProperty('--scroll-progress', (Number.isFinite(p) ? p : 0).toFixed(4));
  const lenis = useLenis(({ progress, limit }) => {
    setProgress(limit > 0 ? progress : 0);
    updateParallax();
  });
  const { pathname, hash } = useLocation();
  useEffect(() => { registerLenis(lenis); return () => registerLenis(null); }, [lenis]);
  useEffect(() => { if (!hash) scrollToTop(); }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  // Content arrives asynchronously and changes the page height without a scroll event: re-measure and re-publish.
  useEffect(() => {
    if (!lenis || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => { lenis.resize(); setProgress(lenis.limit > 0 ? lenis.progress : 0); updateParallax(); });
    ro.observe(document.body);
    return () => ro.disconnect();
  }, [lenis]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { clearParallax(); document.documentElement.style.removeProperty('--scroll-progress'); }, []);
  return null;
}

// Lenis drives the page scroll (the root/window). It is not mounted at all when the user prefers reduced motion,
// so those users keep native, instant scrolling and no scroll-linked animation. Children are never remounted
// when that preference changes.
export function SmoothScroll({ children }) {
  const reduced = usePrefersReducedMotion();
  return (
    <>
      {!reduced && <ReactLenis root options={{ lerp: 0.075, smoothWheel: true, anchors: false }}><Bridge /></ReactLenis>}
      {!reduced && <div className="scroll-progress" aria-hidden="true" />}
      {children}
    </>
  );
}

// ---------- ScrollR ----------
// The signature letter from the headline, carried down the page as a scroll guide. Once the hero has scrolled away a serif "R" docks
// to the edge of the screen; its leg is a line that fills as the reader nears the "Bring your conversations together" section,
// and the whole thing is a link that glides there. It reads the native scroll position (Lenis moves the real window scroll), so it
// works the same with smooth scrolling off, never intercepts wheel or touch scrolling, and only ever animates opacity/transform.
export function ScrollR({ target = 'connect', label = 'Bring your conversations together' }) {
  const [shown, setShown] = useState(false);
  const fill = useRef(null);

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const end = document.getElementById(target);
      if (!end) return;
      const vh = window.innerHeight;
      const y = window.scrollY;
      const dest = end.getBoundingClientRect().top + y; // page position of the section we point at
      const from = vh * 0.5;
      const p = Math.min(1, Math.max(0, (y - from) / Math.max(1, dest - vh * 0.6 - from)));
      fill.current?.style.setProperty('--p', p.toFixed(3));
      setShown(y > from && end.getBoundingClientRect().top > vh * 0.55); // visible between the hero and the section it points to
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onScroll) : null; // content loads late and moves the target
    ro?.observe(document.body);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); ro?.disconnect(); };
  }, [target]);

  return (
    <a href={`#${target}`} className={`scroll-r${shown ? ' is-shown' : ''}`} aria-label={`Continue to: ${label}`} tabIndex={shown ? 0 : -1} aria-hidden={shown ? undefined : 'true'}
      onClick={(e) => { e.preventDefault(); scrollToSection(target); }}>
      <span className="scroll-r-glyph" aria-hidden="true">R</span>
      <span className="scroll-r-leg" ref={fill} aria-hidden="true"><i /></span>
      <span className="scroll-r-label" aria-hidden="true">Next</span>
    </a>
  );
}

// ---------- CountUp ----------
// Counts up to a whole number the first time it scrolls into view (about a second). With reduced motion, or
// when the value is not a positive whole number, the real value is shown immediately.
export function CountUp({ value, duration = 900 }) {
  const ref = useRef(null);
  const reduced = usePrefersReducedMotion();
  const animate = !reduced && Number.isInteger(value) && value > 0 && typeof IntersectionObserver !== 'undefined';
  const [shown, setShown] = useState(animate ? 0 : value);
  const done = useRef(false);

  useEffect(() => {
    if (!animate) { setShown(value); return undefined; }
    if (done.current) { setShown(value); return undefined; }
    let raf = 0;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect(); done.current = true;
      const t0 = performance.now();
      const tick = (now) => {
        const p = Math.min(1, (now - t0) / duration);
        setShown(Math.round(value * (1 - (1 - p) ** 3))); // ease-out
        if (p < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }, { threshold: 0.6 });
    io.observe(ref.current);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, [value, animate, duration]);

  return <span ref={ref}>{shown}</span>;
}
