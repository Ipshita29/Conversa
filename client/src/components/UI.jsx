import { MessageCircle, Camera, PenLine, X, ArrowUpRight } from 'lucide-react';
import { STATUS_LABEL, PAYMENT_LABEL, CHANNEL_LABEL, RISK_LABEL } from '../utils/format.js';
import { DEMO_MODE } from '../services/api.js';
import { useEffect, useRef, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { ReactLenis, useLenis } from 'lenis/react';
import usePrefersReducedMotion from '../hooks/usePrefersReducedMotion.js';
import { registerLenis, scrollToTop, scrollToSection } from '../utils/scroll.js';
import { updateParallax, clearParallax } from '../utils/parallax.js';

// ======== Shared UI ========

// ---------- Badge ----------
export const StatusBadge = ({ status }) => <span className={`badge status-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
export const PaymentBadge = ({ status }) => <span className={`badge pay-${status}`}>{PAYMENT_LABEL[status] ?? status}</span>;

// Risk is never conveyed by colour alone: every level has its own marker shape (diamond, triangle, circle, square) and a text label.
export function RiskBadge({ risk, needsDetails = false }) {
  if (needsDetails) return <span className="badge risk-details"><i className="risk-dot" aria-hidden="true" />Needs details</span>;
  if (!risk) return <span className="badge risk-none">—</span>;
  return <span className={`badge risk-${risk}`}><i className="risk-dot" aria-hidden="true" />{RISK_LABEL[risk]}</span>;
}

const ICONS = { whatsapp: MessageCircle, instagram: MessageCircle, manual: PenLine };
export function ChannelBadge({ channel }) {
  const Icon = ICONS[channel] ?? PenLine;
  return <span className={`badge channel-${channel}`}><Icon size={14} aria-hidden="true" />{CHANNEL_LABEL[channel] ?? channel}</span>;
}

// ---------- DemoBadge ----------
// Renders only in demo mode so simulated data is never mistaken for live data.
export function DemoBadge() { return null; } // orders are orders: nothing on a page is labelled demo or real

// ---------- Modal ----------
// A restrained 3D depth behind the wide dialog: a few soft translucent sheets that settle into place as it opens and drift back as it closes,
// with a hint of parallax from the pointer. Drawn with Three.js (already a dependency, loaded only when needed) on a canvas of its own, so
// the dialog's content is ordinary HTML and stays perfectly readable. Without WebGL it renders nothing and the CSS entrance is all there is.
function DepthBackdrop({ leaving }) {
  const host = useRef(null);
  const leave = useRef(leaving); leave.current = leaving;
  useEffect(() => {
    let gone = false; let cleanup = () => {};
    (async () => {
      const THREE = await import('three');
      if (gone || !host.current) return;
      let renderer;
      try { renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true }); } catch { return; }
      const canvas = renderer.domElement; canvas.setAttribute('aria-hidden', 'true'); host.current.appendChild(canvas);
      renderer.setClearColor(0x000000, 0);
      const scene = new THREE.Scene(); const cam = new THREE.PerspectiveCamera(32, 1, 0.1, 50); cam.position.z = 12;
      const round = (w, h, r) => { const sh = new THREE.Shape(); sh.moveTo(-w / 2 + r, -h / 2); sh.lineTo(w / 2 - r, -h / 2); sh.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r); sh.lineTo(w / 2, h / 2 - r); sh.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2); sh.lineTo(-w / 2 + r, h / 2); sh.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r); sh.lineTo(-w / 2, -h / 2 + r); sh.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2); return new THREE.ShapeGeometry(sh); };
      const sheets = [[8.6, 5.6, -0.8, 0.07, 0x243f73], [8.2, 5.3, -1.7, 0.06, 0xa9c9ee], [7.8, 5, -2.6, 0.07, 0xe8c5a2]].map(([w, h, z, o, c]) => {
        const geo = round(w, h, 0.5); const mat = new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0, depthWrite: false });
        const mesh = new THREE.Mesh(geo, mat); mesh.userData = { z, o }; scene.add(mesh); return mesh;
      });
      let W = 1; let H = 1; let t = 0; let mx = 0; let raf = 0; let last = performance.now();
      const resize = () => { const r = host.current.getBoundingClientRect(); W = Math.max(1, r.width); H = Math.max(1, r.height); renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.setSize(W, H, false); cam.aspect = W / H; cam.updateProjectionMatrix(); };
      const ro = new ResizeObserver(resize); ro.observe(host.current); resize();
      const onMove = (e) => { mx = (e.clientX / window.innerWidth) * 2 - 1; }; window.addEventListener('pointermove', onMove, { passive: true });
      const ease = (k) => 1 - (1 - k) ** 3;
      const frame = (now) => {
        const dt = Math.min(0.05, (now - last) / 1000); last = now;
        t = leave.current ? Math.max(0, t - dt / 0.22) : Math.min(1, t + dt / 0.7); // in: about 0.7s; out: about 0.2s
        const k = ease(t);
        sheets.forEach((m, i) => { const { z, o } = m.userData; m.position.set(mx * 0.12 * (i + 1), (1 - k) * -0.5, z - (1 - k) * 2.2); m.rotation.x = (1 - k) * 0.22; m.rotation.y = mx * 0.025 * (i + 1); m.material.opacity = o * k; });
        cam.position.x += (mx * 0.3 - cam.position.x) * 0.05;
        renderer.render(scene, cam);
        if (!gone && !document.hidden) raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
      cleanup = () => { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('pointermove', onMove); sheets.forEach((m) => { m.geometry.dispose(); m.material.dispose(); }); renderer.dispose(); renderer.getContext()?.getExtension('WEBGL_lose_context')?.loseContext(); canvas.remove(); };
    })().catch(() => {});
    return () => { gone = true; cleanup(); };
  }, []);
  return <div ref={host} className="modal-depth" aria-hidden="true" />;
}

// variant="lightbox": a large picture viewer (dark backdrop, the picture contained and never cropped).
// variant="wide": a roomy two-column dialog with a sticky header whose close button is always on screen (above the floating navbar), its own
// scrolling body and a short depth entrance/exit. Escape, the close button and a click outside all close either kind.
const openModals = []; // newest last: Escape closes only the top one, so a picture opened over an order closes alone
export function Modal({ title, subtitle, onClose, children, variant }) {
  const wide = variant === 'wide';
  const glass = variant === 'glass'; // the translucent order-details overlay: it fades out like the wide one
  const reduced = usePrefersReducedMotion();
  const [leaving, setLeaving] = useState(false);
  const closeRef = useRef(onClose); closeRef.current = onClose; // the stack position is kept when the parent re-renders with a new onClose
  const close = useRef(() => {});
  close.current = () => { if (!(wide || glass) || reduced) { closeRef.current(); return; } if (!leaving) { setLeaving(true); setTimeout(() => closeRef.current(), 220); } };
  useEffect(() => {
    const me = {};
    openModals.push(me);
    const onKey = (e) => e.key === 'Escape' && openModals[openModals.length - 1] === me && close.current();
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); openModals.splice(openModals.indexOf(me), 1); };
  }, []);

  const node = (
    <div className={`modal-backdrop${variant === 'lightbox' ? ' is-lightbox' : ''}${wide ? ' is-wide' : ''}${glass ? ' is-glass' : ''}${variant === 'confirm' ? ' is-confirm' : ''}${leaving ? ' is-leaving' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && close.current()}>
      {wide && !reduced && <DepthBackdrop leaving={leaving} />}
      <div className="modal" data-lenis-prevent role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <h2>{title}{subtitle && <small>{subtitle}</small>}</h2>
          <button type="button" className="icon-btn" onClick={() => close.current()} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
  // A confirmation always sits above whatever opened it. It is rendered straight into <body>, outside every page and dialog (and so outside their transforms,
  // filters and stacking contexts), and has its own layer above all the other dialogs.
  return variant === 'confirm' ? createPortal(node, document.body) : node;
}

// ---------- Drawer ----------
// Right-hand slide-over. Escape or backdrop click closes; focus moves to the close button on open.
export function Drawer({ title, onClose, children }) {
  const closeRef = useRef(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" data-lenis-prevent role="dialog" aria-modal="true" aria-label={title}>
        <header className="drawer-header">
          <h2>{title}</h2>
          <button type="button" ref={closeRef} className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

// ---------- StateMessage ----------
export function StateMessage({ kind = 'empty', message, onRetry, children }) {
  return (
    <div className={`state-message state-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <p>{message}</p>
      {children}
      {onRetry && <button type="button" className="btn btn-primary" onClick={onRetry}>Try again</button>}
    </div>
  );
}

// ======== Effects, scrolling and the home hero ========

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
          <a href="#connect" className="btn btn-lg" onClick={go('connect')}>See how it works <ArrowUpRight size={16} aria-hidden="true" /></a>
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

// ======== Facet field (home hero background) ========

// The home page's floating field of faceted polyhedra. Ported from the Framer "Facet Field" component (light theme, scroll-story mode):
// the same physics, mouse repulsion, scroll stages and pastel palette. The page scroll position (window.scrollY / innerHeight) drives the story:
// hero cluster on the sides -> drop -> heart -> fly toward the camera. Reduced motion or no WebGL falls back to flat pastel shapes.

const BG = {
  hero: ['#FFFFFF', '#F7F4ED', '#E3E9F3'],
  caramel: ['#FFFDF8', '#F8ECDA', '#EFD9B8'],
  teal: ['#FDFFFE', '#E6F5F2', '#C8E7E2'],
};
const gradient = (c) => `radial-gradient(circle at 50% 42%, ${c[0]} 0%, ${c[1]} 40%, ${c[2]} 100%)`;
const PALETTES = {
  hero: { pastel: '#E7F0FB', light: '#C7DDF5', medium: '#A9C9EE', deep: '#E8C5A2', glass: '#B8E3DE' },
  caramel: { pastel: '#E7F0FB', light: '#E8C5A2', medium: '#E8C5A2', deep: '#B8C8F0', glass: '#B8E3DE' },
  teal: { pastel: '#E7F0FB', light: '#B8E3DE', medium: '#B8E3DE', deep: '#A9C9EE', glass: '#B8C8F0' },
};
export const HOME_PALETTE = PALETTES.hero; // the homepage's colours, shared with the Insights scene so the two read as one product
let THREE = null; // the three.js module, once loaded
const toColors = (p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, new THREE.Color(v)]));
const ROLES = ['pastel', 'light', 'medium', 'deep', 'glass'];
const OVERLAY = 'radial-gradient(ellipse 46% 40% at 50% 48%, rgba(247,244,237,0.92) 0%, rgba(247,244,237,0.62) 45%, rgba(247,244,237,0) 100%)';

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

// Flat pastel shapes at the sides: used for reduced motion and when WebGL is unavailable.
function StaticFacets() {
  const fills = ['#C7DDF5', '#B8E3DE', '#A9C9EE', '#E8C5A2', '#B8C8F0', '#E7F0FB', '#C7DDF5', '#B8E3DE'];
  const shapes = [[12, 30, 90, 0], [15, 56, 60, 30], [9, 68, 70, 60], [20, 16, 44, 15], [87, 34, 100, 45], [85, 60, 56, 20], [91, 70, 72, 70], [80, 18, 46, 10]];
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" className="facet-static" aria-hidden="true">
      {shapes.map(([x, y, s, r], i) => (
        <polygon key={i} points="0,-1 0.95,-0.31 0.59,0.81 -0.59,0.81 -0.95,-0.31" transform={`translate(${x} ${y}) rotate(${r}) scale(${s / 18})`} fill={fills[i % fills.length]} opacity="0.85" />
      ))}
    </svg>
  );
}

export function Field() {
  const [ready, setReady] = useState(Boolean(THREE));
  const reduced = usePrefersReducedMotion();
  const [webgl] = useState(() => typeof document !== 'undefined' && webglAvailable());
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const bgRef = useRef(null);
  const overlayRef = useRef(null);
  const live = !reduced && webgl;

  useEffect(() => { // three.js is loaded on demand so it stays out of the main bundle
    if (!live || THREE) return;
    import('three').then((m) => { THREE = m; setReady(true); }).catch(() => {});
  }, [live]);

  useEffect(() => {
    if (!live || !ready) return undefined;
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return undefined;

    const mousePos = { x: 99, y: 99, isDown: false };
    const control = { progress: 0, started: false };

    let bgStage = -1;
    const setBg = (stage) => {
      if (stage === bgStage || !bgRef.current) return;
      bgStage = stage;
      bgRef.current.style.background = gradient(stage === 2 ? BG.teal : stage === 1 ? BG.caramel : BG.hero);
    };
    if (overlayRef.current) overlayRef.current.style.background = OVERLAY;

    let scrollRaf = 0;
    const readScroll = () => {
      scrollRaf = 0;
      const vh = window.innerHeight || 1;
      const progress = window.scrollY / vh;
      control.progress = progress;
      if (overlayRef.current) { // the cream text-zone glow fades out as the hero scrolls away
        const t = Math.min(1, Math.max(0, (progress - 0.3) / 0.5));
        overlayRef.current.style.opacity = String(1 - t * t * (3 - 2 * t));
      }
      setBg(progress > 1.55 ? 2 : progress > 0.7 ? 1 : 0);
    };
    const onScroll = () => { if (!scrollRaf) scrollRaf = requestAnimationFrame(readScroll); };
    readScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);

    const onMove = (e) => { mousePos.x = (e.clientX / window.innerWidth) * 2 - 1; mousePos.y = -(e.clientY / window.innerHeight) * 2 + 1; };
    const onOut = (e) => { if (!e.relatedTarget) { mousePos.x = 99; mousePos.y = 99; } };
    const onDown = () => { mousePos.isDown = true; };
    const onUp = () => { mousePos.isDown = false; };
    window.addEventListener('pointermove', onMove);
    document.addEventListener('pointerout', onOut);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, container.clientWidth / container.clientHeight, 0.1, 100);
    camera.position.set(0, 0, 11);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25; // light theme: keeps the pastel tints from blowing out
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const hemiLight = new THREE.HemisphereLight(0xffffff, new THREE.Color('#A9C9EE'), 1.6);
    scene.add(hemiLight);
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
    keyLight.position.set(-6, 10, 8);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 2048; keyLight.shadow.mapSize.height = 2048;
    keyLight.shadow.camera.near = 0.5; keyLight.shadow.camera.far = 30;
    keyLight.shadow.camera.left = -8; keyLight.shadow.camera.right = 8; keyLight.shadow.camera.top = 8; keyLight.shadow.camera.bottom = -8;
    keyLight.shadow.bias = -0.0003; keyLight.shadow.radius = 12.0;
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0xffffff, 1.25); rimLight.position.set(8, 7, -8); scene.add(rimLight);
    const frontLight = new THREE.DirectionalLight(0xffffff, 0.4); frontLight.position.set(0, 0, 11); scene.add(frontLight);
    const sideBounceLight = new THREE.DirectionalLight(0xffffff, 0.3); sideBounceLight.position.set(-9, -2, 4); scene.add(sideBounceLight);

    let viewportWidth = 10;
    let viewportHeight = 6;
    const updateFrustumBounds = () => {
      const fovRad = THREE.MathUtils.degToRad(camera.fov);
      viewportHeight = 2 * Math.tan(fovRad / 2) * camera.position.z;
      viewportWidth = viewportHeight * (container.clientWidth / container.clientHeight);
    };
    updateFrustumBounds();

    const isMobile = window.innerWidth < 768;
    const ballCount = isMobile ? 24 : 56;

    const palHero = toColors(PALETTES.hero);
    const palMint = toColors(PALETTES.caramel);
    const palPearl = toColors(PALETTES.teal);
    const curPal = Object.fromEntries(ROLES.map((r) => [r, new THREE.Color()]));

    // Polyhedra inscribed in the unit sphere; scaled up slightly so facets meet the collision radius.
    const geometries = [new THREE.IcosahedronGeometry(1, 0), new THREE.DodecahedronGeometry(1, 0), new THREE.OctahedronGeometry(1, 0)];
    const FACET_SCALE = 1.08;
    const balls = [];
    const materials = [];
    for (let i = 0; i < ballCount; i++) {
      let radius;
      const rand = Math.random();
      if (rand < 0.3) radius = 0.27 + Math.random() * 0.12;
      else if (rand < 0.8) radius = 0.42 + Math.random() * 0.18;
      else radius = 0.66 + Math.random() * 0.21;
      const mass = radius ** 3;

      let sphereMat;
      let role = 'medium';
      const isGlass = Math.random() < 0.22;
      if (isGlass) {
        sphereMat = new THREE.MeshPhysicalMaterial({
          color: palHero.glass, roughness: 0.08, metalness: 0.0, clearcoat: 1.0, clearcoatRoughness: 0.03, transmission: 0.95, ior: 1.485, thickness: 2.2,
          specularColor: new THREE.Color('#ffffff'), specularIntensity: 1.0, attenuationColor: palHero.pastel, attenuationDistance: 1.0,
          emissive: palHero.glass, emissiveIntensity: 0.12, transparent: true, flatShading: true,
        });
        role = 'glass';
      } else {
        const colorRand = Math.random();
        let chosen;
        if (colorRand < 0.25) { chosen = palHero.pastel; role = 'pastel'; }
        else if (colorRand < 0.55) { chosen = palHero.light; role = 'light'; }
        else if (colorRand < 0.85) { chosen = palHero.medium; role = 'medium'; }
        else { chosen = palHero.deep; role = 'deep'; }
        sphereMat = new THREE.MeshPhysicalMaterial({
          color: chosen, roughness: 0.44, metalness: 0.0, clearcoat: 0.24, clearcoatRoughness: 0.35, emissive: chosen, emissiveIntensity: 0.08, transparent: true, flatShading: true,
        });
      }
      materials.push(sphereMat);

      const shapeRand = Math.random();
      const geometry = shapeRand < 0.5 ? geometries[0] : shapeRand < 0.8 ? geometries[1] : geometries[2];
      const group = new THREE.Group();
      const mesh = new THREE.Mesh(geometry, sphereMat);
      mesh.scale.setScalar(radius * FACET_SCALE);
      mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      scene.add(group);

      balls.push({
        id: i, radius, mass, position: new THREE.Vector3(), velocity: new THREE.Vector3(), meshGroup: group, sphere: mesh, material: sphereMat, role, isGlass,
        visualScale: radius, shapeTarget: new THREE.Vector3(), spin: (Math.random() - 0.5) * 0.006, zoneAlpha: 1,
      });
    }

    const meanRadius = balls.reduce((s, b) => s + b.radius, 0) / balls.length;
    let shapeScale = 1;

    const inHeart = (x, y) => { const a = x * x + y * y - 1; return a * a * a - x * x * y * y * y <= 0; };
    const assignHeartTargets = () => {
      const S = Math.min(viewportWidth * 0.3, viewportHeight * 0.27);
      const baseCY = -viewportHeight * 0.03;
      shapeScale = Math.max(0.3, Math.min(1, (S * 0.45) / 2.3 / meanRadius));
      for (let i = 0; i < balls.length; i++) {
        let x = 0, y = 0, tries = 0;
        do { x = (Math.random() * 2 - 1) * 1.25; y = Math.random() * 2.55 - 1.4; tries++; } while (!inHeart(x, y) && tries < 60);
        balls[i].shapeTarget.set(x * S, (y + 0.12) * S + baseCY, (Math.random() - 0.5) * 0.35);
      }
    };
    assignHeartTargets();

    const scatterFar = (withInwardVelocity) => {
      const R = Math.max(viewportWidth, viewportHeight) * 1.5;
      for (const b of balls) {
        const a = Math.random() * Math.PI * 2;
        const px = Math.cos(a) * R * 1.25;
        const py = Math.sin(a) * R * 0.85;
        const pz = (Math.random() - 0.5) * 4;
        b.position.set(px, py, pz);
        b.meshGroup.position.copy(b.position);
        if (withInwardVelocity) b.velocity.set(-px, -py, -pz).normalize().multiplyScalar(0.08 + Math.random() * 0.05);
        else b.velocity.set(0, 0, 0);
      }
    };
    scatterFar(false);

    const params = { rebound: -0.3, mouseRepelForce: 0.05, mouseRepelRadius: 4.4, centerAttractForce: 0.0035, bounciness: 0.02 };

    const mouseProjVec = new THREE.Vector3();
    const mouseWorld3D = new THREE.Vector3();
    const updateMouse3D = () => {
      mouseProjVec.set(mousePos.x, mousePos.y, 0.5);
      mouseProjVec.unproject(camera);
      const dir = mouseProjVec.sub(camera.position).normalize();
      const distance = -camera.position.z / dir.z;
      mouseWorld3D.copy(camera.position).add(dir.multiplyScalar(distance));
    };

    const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
    const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
    const lerp = (a, b, t) => a + (b - a) * t;
    const easeOutCubic = (t) => 1 - (1 - t) ** 3;

    let animationFrameId = 0;
    const clock = new THREE.Clock();
    let localStarted = false;
    let entranceStart = 0;
    let visible = true;

    const diffVec = new THREE.Vector3();
    const collideDiff = new THREE.Vector3();
    const relVel = new THREE.Vector3();
    const deltaPos = new THREE.Vector3();
    const rotAxis = new THREE.Vector3();
    const prevMouseWorld = new THREE.Vector3();
    let mouseSpeed = 0;

    const simulateAndRender = () => {
      animationFrameId = requestAnimationFrame(simulateAndRender);
      if (!visible) return;
      const time = clock.getElapsedTime();
      updateMouse3D();

      if (!localStarted) { // first frame: render the scattered scene once, then fly the facets in
        renderer.render(scene, camera);
        localStarted = true;
        entranceStart = time;
        scatterFar(true);
        return;
      }

      const progress = control.progress;
      const heroF = 1 - smoothstep(0.3, 0.8, progress);
      const dropRaw = smoothstep(0.4, 0.95, progress);
      const flyF = smoothstep(2.7, 3.45, progress);
      const shapeF = smoothstep(1.4, 2.05, progress) * (1 - smoothstep(2.55, 3.0, progress));
      const dropF = dropRaw * (1 - smoothstep(1.25, 1.75, progress));

      const bMint = smoothstep(0.55, 1.05, progress);
      const bPearl = smoothstep(1.4, 1.95, progress);
      for (const role of ROLES) curPal[role].copy(palHero[role]).lerp(palMint[role], bMint).lerp(palPearl[role], bPearl);
      hemiLight.groundColor.copy(curPal.medium);

      const entranceT = easeOutCubic(clamp01((time - entranceStart) / 2.2));
      const attractionBoost = lerp(7.5, 1, entranceT);
      const isMouseInteracting = Math.abs(mousePos.x) < 0.99 || Math.abs(mousePos.y) < 0.99;

      mouseSpeed = isMouseInteracting ? mouseWorld3D.distanceTo(prevMouseWorld) : 0;
      if (mouseSpeed > 3) mouseSpeed = 3;
      prevMouseWorld.copy(mouseWorld3D);

      let damping = 0.91;
      damping = lerp(damping, 0.992, dropF);
      damping = lerp(damping, 0.9, shapeF);
      damping = lerp(damping, 0.985, flyF);

      const camZ = camera.position.z;
      const clusterActive = Math.max(heroF, entranceT < 1 ? 1 : 0);

      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        if (heroF > 0.01) {
          b.velocity.x += Math.sin(time * 0.4 + b.id * 1.5) * 0.0004 * b.radius * heroF;
          b.velocity.y += Math.cos(time * 0.5 + b.id * 1.2) * 0.0004 * b.radius * heroF;
          b.velocity.z += Math.sin(time * 0.35 + b.id) * 0.0001 * heroF;
        }
        // Hero: facets are drawn to lanes at the left and right edges (above and below the text on phones), never to the middle.
        const clusterStrength = params.centerAttractForce * attractionBoost * clusterActive;
        if (clusterStrength > 0.00001) {
          b.velocity.x += ((!isMobile ? (b.id % 2 ? 1 : -1) * viewportWidth * 0.38 : 0) - b.position.x) * clusterStrength * 0.38;
          b.velocity.y += ((isMobile ? (b.id % 2 ? 1 : -1) * viewportHeight * 0.43 : 0) - b.position.y) * clusterStrength * 1.85;
          b.velocity.z += (0 - b.position.z) * clusterStrength * 1.8;
        }
        // A soft push-out zone keeps facets from settling behind the text, and fades any that stray into it.
        b.zoneAlpha = 1;
        if (heroF > 0.01) {
          const zx = viewportWidth * (isMobile ? 0.5 : 0.35); // wide enough for the 112px headline even at 1200px
          const zy = viewportHeight * (isMobile ? 0.36 : 0.36); // tall enough to include the stats line under the buttons
          const nx = b.position.x / zx;
          const ny = b.position.y / zy;
          const zd = Math.sqrt(nx * nx + ny * ny);
          if (zd < 1) {
            const dd = Math.max(zd, 0.05);
            const push = (1 - zd) * 0.03 * heroF;
            b.velocity.x += (nx / dd) * push;
            b.velocity.y += (ny / dd) * push * 0.6;
            b.zoneAlpha = 1 - 0.65 * (1 - zd) * heroF;
          }
        }
        if (dropF > 0.001) b.velocity.y -= 0.011 * dropF;
        if (shapeF > 0.001) {
          const k = 0.06 * shapeF;
          b.velocity.x += (b.shapeTarget.x - b.position.x) * k;
          b.velocity.y += (b.shapeTarget.y - b.position.y) * k;
          b.velocity.z += (b.shapeTarget.z - b.position.z) * k;
        }
        if (flyF > 0.001) {
          const stagger = (b.id * 0.6180339887) % 1;
          const local = smoothstep(stagger * 0.55, stagger * 0.55 + 0.45, flyF);
          b.velocity.z += 0.05 * local;
          b.velocity.x += b.position.x * 0.006 * local;
          b.velocity.y += b.position.y * 0.006 * local;
        }
        if (isMouseInteracting) {
          diffVec.subVectors(b.position, mouseWorld3D);
          const rawDist = diffVec.length();
          const down = mousePos.isDown;
          const activeRepelRadius = down ? params.mouseRepelRadius * 1.4 : params.mouseRepelRadius;
          const activeRepelForce = down ? params.mouseRepelForce * 1.7 : params.mouseRepelForce;
          if (rawDist < activeRepelRadius && rawDist > 0.0001) {
            const ratio = rawDist / activeRepelRadius;
            const smoothFactor = 1.0 - ratio * ratio * (3.0 - 2.0 * ratio);
            const speedBoost = 1 + mouseSpeed * 3.2;
            const push = smoothFactor * activeRepelForce * speedBoost;
            diffVec.normalize();
            diffVec.z *= 0.12;
            diffVec.normalize();
            b.velocity.addScaledVector(diffVec, push);
          }
        }

        b.velocity.multiplyScalar(damping);
        b.position.addScaledVector(b.velocity, 1);

        const c = b.isGlass ? curPal.glass : curPal[b.role];
        b.material.color.copy(c);
        b.material.emissive.copy(c);
        b.material.opacity = (flyF > 0.001 ? 1 - smoothstep(camZ - 2.6, camZ - 0.3, b.position.z) : 1) * b.zoneAlpha;

        const targetVis = b.radius * (1 - (1 - shapeScale) * shapeF);
        b.visualScale += (targetVis - b.visualScale) * 0.12;
        b.sphere.scale.setScalar(b.visualScale * FACET_SCALE);
      }

      const collideScale = 0.28 * (1 - 0.93 * shapeF) * (1 - flyF);
      const subSteps = 4;
      for (let step = 0; step < subSteps; step++) {
        for (let i = 0; i < balls.length; i++) {
          for (let j = i + 1; j < balls.length; j++) {
            const b1 = balls[i];
            const b2 = balls[j];
            collideDiff.subVectors(b2.position, b1.position);
            const dist = collideDiff.length();
            const minDist = b1.visualScale + b2.visualScale;
            if (dist < minDist && dist > 0.001) {
              const overlap = minDist - dist;
              collideDiff.multiplyScalar(1 / dist);
              const totalMass = b1.mass + b2.mass;
              b1.position.addScaledVector(collideDiff, -overlap * (b2.mass / totalMass) * collideScale);
              b2.position.addScaledVector(collideDiff, overlap * (b1.mass / totalMass) * collideScale);
              relVel.subVectors(b2.velocity, b1.velocity);
              const velAlongNormal = relVel.dot(collideDiff);
              if (velAlongNormal < -0.0001) {
                const impulse = (-(1 + params.bounciness) * velAlongNormal) / (1 / b1.mass + 1 / b2.mass);
                b1.velocity.addScaledVector(collideDiff, -impulse / b1.mass);
                b2.velocity.addScaledVector(collideDiff, impulse / b2.mass);
              }
            }
          }
        }
      }

      const borderPad = 0.2;
      const xBound = viewportWidth / 2 - borderPad;
      const topY = viewportHeight / 2 - 0.05;
      const floorY = -viewportHeight / 2 + 0.05;
      const zBound = 2.0;
      const restitution = 0.3 + 0.35 * dropF;
      const contain = flyF < 0.5;
      const zContain = flyF < 0.02;

      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        const r = b.visualScale;
        if (contain) {
          if (b.position.x < -xBound - r) { b.position.x = -xBound - r; b.velocity.x *= params.rebound; }
          else if (b.position.x > xBound + r) { b.position.x = xBound + r; b.velocity.x *= params.rebound; }
          if (b.position.y - r < floorY) {
            b.position.y = floorY + r;
            if (b.velocity.y < 0) b.velocity.y = -b.velocity.y * restitution;
            if (dropF > 0.3) { b.velocity.x *= 0.86; b.velocity.z *= 0.86; }
          }
          if (b.position.y + r > topY) {
            b.position.y = topY - r;
            if (b.velocity.y > 0) b.velocity.y *= params.rebound;
          }
        }
        if (zContain) {
          if (b.position.z < -zBound) { b.position.z = -zBound; b.velocity.z *= params.rebound; }
          else if (b.position.z > zBound) { b.position.z = zBound; b.velocity.z *= params.rebound; }
        }
        deltaPos.copy(b.position).sub(b.meshGroup.position);
        if (deltaPos.lengthSq() > 0.000001) {
          rotAxis.set(deltaPos.y, -deltaPos.x, 0).normalize();
          const rotAngle = (deltaPos.length() / b.radius) * 0.95;
          b.meshGroup.rotateOnWorldAxis(rotAxis, rotAngle);
        }
        b.sphere.rotation.y += b.spin;
        b.meshGroup.position.copy(b.position);
      }

      renderer.render(scene, camera);
    };
    simulateAndRender();

    const handleResize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (!width || !height) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      updateFrustumBounds();
      assignHeartTargets();
    };
    const ro = new ResizeObserver(handleResize);
    ro.observe(container);
    const io = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; });
    io.observe(container);

    return () => {
      cancelAnimationFrame(animationFrameId);
      cancelAnimationFrame(scrollRaf);
      ro.disconnect();
      io.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerout', onOut);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      geometries.forEach((geo) => geo.dispose());
      materials.forEach((m) => m.dispose());
      renderer.dispose();
    };
  }, [live, ready]);

  return (
    <div ref={containerRef} className="facet-field" aria-hidden="true">
      <div ref={bgRef} className="facet-bg" style={{ background: gradient(BG.hero) }} />
      {live ? <canvas ref={canvasRef} className="facet-canvas" /> : <StaticFacets />}
      {live && <div ref={overlayRef} className="facet-zone" />}
    </div>
  );
}
