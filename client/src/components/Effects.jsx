import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { DEMO_MODE } from '../services/api.js';
import { ReactLenis, useLenis } from 'lenis/react';
import usePrefersReducedMotion from '../hooks/usePrefersReducedMotion.js';
import { registerLenis, scrollToTop, scrollToSection } from '../utils/scroll.js';
import { updateParallax, clearParallax } from '../utils/parallax.js';
import { DemoBadge } from './UI.jsx';

// ---------- HeroSection ----------
// Three pieces (eyebrow, headline, aside) spring in with blur and tilt, then drift up, shrink and fade away as the page scrolls.
// Ported from the Framer hero (same spring, delays, speeds and fade distances). Values are written straight to inline styles on
// requestAnimationFrame, so React never re-renders on scroll. Reduced motion leaves the hero completely still.
const PIECES = {
  eyebrow: { delay: 0.05, speed: 1.5, shrink: 0.1, blur: 10, tilt: 18, fadeEnd: 0.45 },
  headline: { delay: 0.18, speed: 1.0, shrink: 0.14, blur: 14, tilt: 14, fadeEnd: 0.7 },
  aside: { delay: 0.34, speed: 0.6, shrink: 0.06, blur: 8, tilt: 10, fadeEnd: 0.55 },
};
const SPRING = { k: 70, c: 16 }; // stiffness / damping (mass 1)

function useHeroPieces(rootRef) {
  const reduced = usePrefersReducedMotion();
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || reduced) return undefined;
    const pieces = [...root.querySelectorAll('[data-piece]')].map((el) => ({ el, cfg: PIECES[el.dataset.piece], e: 0, v: 0, start: null }));
    const t0 = performance.now();
    const render = () => {
      const vh = window.innerHeight || 800;
      const p = Math.min(1, Math.max(0, window.scrollY / vh));
      for (const { el, cfg, e } of pieces) {
        const y = (1 - e) * 46 - p * vh * 0.35 * cfg.speed;
        const opacity = Math.min(1, Math.max(0, e)) * (1 - Math.min(1, p / cfg.fadeEnd));
        const scale = 0.92 + 0.08 * Math.min(1, Math.max(0, e)) - p * cfg.shrink;
        const rx = (1 - e) * cfg.tilt + p * cfg.tilt * 1.4;
        const blur = Math.max(0, (1 - e) * 16 + p * cfg.blur);
        el.style.opacity = opacity.toFixed(3);
        el.style.transform = `perspective(1000px) translateY(${y.toFixed(1)}px) scale(${scale.toFixed(4)}) rotateX(${rx.toFixed(2)}deg)`;
        el.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : 'none';
      }
    };
    let raf = 0;
    let last = t0;
    const step = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      let moving = false;
      for (const s of pieces) {
        if ((now - t0) / 1000 < s.cfg.delay) { moving = true; continue; }
        const acc = -SPRING.k * (s.e - 1) - SPRING.c * s.v;
        s.v += acc * dt;
        s.e += s.v * dt;
        if (Math.abs(s.e - 1) > 0.001 || Math.abs(s.v) > 0.001) moving = true; else { s.e = 1; s.v = 0; }
      }
      render();
      raf = moving ? requestAnimationFrame(step) : 0;
    };
    render(); // first paint is already in the "before" pose: no flash of the finished hero
    raf = requestAnimationFrame(step);
    const onScroll = () => render();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      for (const { el } of pieces) { el.style.opacity = ''; el.style.transform = ''; el.style.filter = ''; }
    };
  }, [rootRef, reduced]);
}

export function HeroSection({ stats, attention }) {
  const needs = attention ?? stats?.atRisk;
  const rootRef = useRef(null);
  useHeroPieces(rootRef);
  const go = (id) => (e) => { e.preventDefault(); scrollToSection(id); };
  return (
    <div className="hero" ref={rootRef}>
      <div className="hero-piece" data-piece="eyebrow">
        <p className="chip"><i aria-hidden="true" />Order management for chat-first businesses</p>
      </div>
      <h1 className="hero-piece hero-title" data-piece="headline">
        <span className="hero-sans">Every order feels</span>
        <em className="hero-serif">effortless.</em>
      </h1>
      <div className="hero-piece hero-aside" data-piece="aside">
        <p className="hero-lede">Know what you can promise. Plan what comes next. Deliver with confidence.</p>
        <div className="hero-actions">
          <a href="#product" className="btn btn-primary btn-lg" onClick={go('product')}>Explore Conversa <ArrowUpRight size={16} aria-hidden="true" /></a>
          <a href="#planning" className="btn btn-lg" onClick={go('planning')}>See how it works <ArrowUpRight size={16} aria-hidden="true" /></a>
        </div>
        {(stats || DEMO_MODE) && (
          <p className="hero-summary">
            {stats && <>{stats.total} {DEMO_MODE ? 'demo ' : ''}{stats.total === 1 ? 'order' : 'orders'} · {needs} {needs === 1 ? 'needs' : 'need'} attention</>}
            <DemoBadge />
          </p>
        )}
      </div>
    </div>
  );
}

// ---------- CardGlow ----------
// A soft light follows the cursor inside every .fx-card (the card's .fx-glow layer paints it; it only ever changes a background).
export function useCardGlow(rootRef) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !window.matchMedia('(hover: hover) and (prefers-reduced-motion: no-preference)').matches) return undefined;
    const cleanups = [...root.querySelectorAll('.fx-card')].map((card) => {
      const glow = card.querySelector('.fx-glow');
      if (!glow) return () => {};
      let raf = 0;
      const fade = (to) => {
        cancelAnimationFrame(raf);
        const from = parseFloat(glow.style.getPropertyValue('--ga') || '0');
        const t0 = performance.now();
        const step = (now) => {
          const t = Math.min(1, (now - t0) / 320);
          glow.style.setProperty('--ga', (from + (to - from) * (1 - (1 - t) ** 3)).toFixed(3));
          if (t < 1) raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
      };
      const enter = () => fade(1);
      const leave = () => fade(0);
      const move = (e) => {
        const r = card.getBoundingClientRect();
        glow.style.setProperty('--gx', `${(e.clientX - r.left).toFixed(0)}px`);
        glow.style.setProperty('--gy', `${(e.clientY - r.top).toFixed(0)}px`);
      };
      card.addEventListener('pointerenter', enter);
      card.addEventListener('pointermove', move);
      card.addEventListener('pointerleave', leave);
      return () => { cancelAnimationFrame(raf); card.removeEventListener('pointerenter', enter); card.removeEventListener('pointermove', move); card.removeEventListener('pointerleave', leave); };
    });
    return () => cleanups.forEach((c) => c());
  }, [rootRef]);
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
