import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Menu, Hexagon, ArrowUpRight, House, LayoutGrid, AlarmClock, FlaskConical, Inbox, ShoppingBag, Wallet } from 'lucide-react';
import { scrollToTop } from '../utils/scroll.js';
import { DEMO_MODE } from '../services/api.js';
import { DemoBadge } from './UI.jsx';
import usePrefersReducedMotion from '../hooks/usePrefersReducedMotion.js';
import '../css/Layout.css';

// ======== Layout ========

// ---------- Navbar ----------
// A centred floating pill, as in the Conversa design: wordmark, the places you go most, and one blue call to action.
// The same places (plus Integrations and the demo note) live in the popover menu, which is also the whole navigation on small screens.
const WORKSPACE = [
  { key: 'overview', to: '/', label: 'Home', hint: 'Your day, organised', icon: House },
  { key: 'orders', to: '/orders', label: 'Orders', hint: 'Every order, every channel', icon: ShoppingBag },
  { key: 'payments', to: '/payments', label: 'Payments', hint: 'Paid, owed and to verify', icon: Wallet },
  { key: 'plan', to: '/plan', label: 'Plan', hint: 'What to make, and when', icon: AlarmClock },
  { key: 'insights', to: '/insights', label: 'Insights', hint: 'Your month at a glance', icon: LayoutGrid },
  { key: 'whatif', to: '/whatif', label: 'What-if', hint: 'Test a change first', icon: FlaskConical },
];
const PAGES = [
  { key: 'inbox', to: '/inbox', label: 'Messages', hint: 'Chats from every channel', icon: Inbox },
];
const PILL_LINKS = [...WORKSPACE.filter((i) => i.key !== 'overview'), ...PAGES];

export function Navbar() {
  const { pathname, hash } = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const rootRef = useRef(null);

  const close = useCallback((refocus = false) => { setOpen(false); if (refocus) triggerRef.current?.focus(); }, []);
  useEffect(() => { setOpen(false); }, [pathname, hash]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Same page + no hash: scroll to the top. Otherwise let the router navigate (pages scroll to #hash themselves).
  function onItem(e, to) {
    close();
    const [path, h] = to.split('#');
    if (path === pathname) {
      e.preventDefault();
      navigate(to); // also drops a stale #hash from the URL
      if (!h) scrollToTop();
    }
  }

  const isOn = (item) => pathname === item.to;

  const items = () => [...(menuRef.current?.querySelectorAll('a') ?? [])];
  function onMenuKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const list = items();
    const i = list.indexOf(document.activeElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
    list[next]?.focus();
  }
  function onTriggerKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setTimeout(() => items()[0]?.focus(), 30); }
    if (e.key === 'Escape') close();
  }
  // Tabbing away from the menu closes it (only when focus really lands somewhere else).
  const onBlur = (e) => { if (open && e.relatedTarget && !rootRef.current?.contains(e.relatedTarget)) setOpen(false); };

  return (
    <nav className="navbar" aria-label="Main" ref={rootRef} onBlur={onBlur}>
      <div className="navbar-inner">
        <div className="navbar-pill">
          <Link to="/" className="wordmark" onClick={(e) => onItem(e, '/')}><Hexagon size={18} aria-hidden="true" /><span>conversa</span></Link>
          <ul className="nav-links">
            {PILL_LINKS.map((item) => (
              <li key={item.key}>
                <Link to={item.to} className={`nav-link${isOn(item) ? ' active' : ''}`} aria-current={isOn(item) ? 'page' : undefined} onClick={(e) => onItem(e, item.to)}>{item.label}</Link>
              </li>
            ))}
          </ul>
          <div className="nav-actions">
            <Link to="/#product" className="btn btn-primary nav-cta" onClick={(e) => onItem(e, '/#product')}>Explore Conversa <ArrowUpRight size={15} aria-hidden="true" /></Link>
            <button type="button" ref={triggerRef} className="menu-trigger" aria-expanded={open} aria-controls="main-menu" aria-label={open ? 'Close menu' : 'Open menu'}
              onClick={() => setOpen(!open)} onKeyDown={onTriggerKey}>
              <Menu size={19} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div id="main-menu" ref={menuRef} className={`menu${open ? ' is-open' : ''}`} role="group" aria-label="Navigation menu" data-lenis-prevent onKeyDown={onMenuKey} inert={open ? undefined : ''}>
          <p className="menu-group" id="menu-workspace">Workspace</p>
          <ul className="menu-list" aria-labelledby="menu-workspace">
            {WORKSPACE.map((item) => {
              const on = isOn(item); const Icon = item.icon;
              return (
                <li key={item.key}>
                  <Link to={item.to} className={`menu-link${on ? ' active' : ''}`} aria-current={on ? 'page' : undefined} onClick={(e) => onItem(e, item.to)}>
                    <Icon size={17} aria-hidden="true" /><span>{item.label}<small>{item.hint}</small></span>
                  </Link>
                </li>
              );
            })}
          </ul>

          <p className="menu-group" id="menu-pages">More</p>
          <ul className="menu-list" aria-labelledby="menu-pages">
            {PAGES.map(({ to, label, hint, icon: Icon }) => (
              <li key={to}>
                <NavLink to={to} onClick={() => close()} className="menu-link"><Icon size={17} aria-hidden="true" /><span>{label}<small>{hint}</small></span></NavLink>
              </li>
            ))}
          </ul>

          <div className="menu-foot">
            <NavLink to="/settings" className="menu-small" onClick={() => close()}>Integrations</NavLink>
            <p className="navbar-tagline">The AI reads. Rules decide. You approve.</p>
            {DEMO_MODE && <p className="navbar-demo">Demo mode · simulated data</p>}
          </div>
        </div>
      </div>
    </nav>
  );
}

// ---------- Footer ----------
// The closing glass panel from the design: a call to action, two short link columns, and the wordmark with the copyright line.
export function Footer() {
  return (
    <footer className="site-footer">
      <div className="sf-panel">
        <div className="sf-top">
          <div className="sf-cta">
            <p className="chip"><i aria-hidden="true" />Order management for chat-first businesses</p>
            <h2 className="sf-title"><span>Make every order</span> <em>effortless.</em></h2>
            <div className="sf-actions">
              <Link to="/orders" className="btn btn-primary">Open your orders <ArrowUpRight size={15} aria-hidden="true" /></Link>
              <Link to="/whatif" className="btn">Try a what-if <ArrowUpRight size={15} aria-hidden="true" /></Link>
            </div>
          </div>
          <div className="sf-cols">
            <nav aria-label="Product">
              <p className="eyebrow">Product</p>
              <ul><li><Link to="/orders">Orders</Link></li><li><Link to="/payments">Payments</Link></li><li><Link to="/plan">Plan</Link></li><li><Link to="/insights">Insights</Link></li><li><Link to="/whatif">What-if</Link></li></ul>
            </nav>
            <nav aria-label="Explore">
              <p className="eyebrow">Explore</p>
              <ul><li><Link to="/">Home</Link></li><li><Link to="/inbox">Messages</Link></li><li><Link to="/settings">Integrations</Link></li></ul>
            </nav>
          </div>
        </div>
        <div className="sf-bottom">
          <Link to="/" className="wordmark"><Hexagon size={18} aria-hidden="true" /><span>conversa</span></Link>
          <p className="sf-legal">© {new Date().getFullYear()} Conversa · Orders, planned realistically.</p>
        </div>
      </div>
    </footer>
  );
}

// ---------- PageHeader ----------
export function PageHeader({ eyebrow, title, subtitle, children, demo = true }) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      <div className="page-header-actions">
        {demo && <DemoBadge />}
        {children}
      </div>
    </header>
  );
}

// ---------- SectionHead ----------
export function SectionHead({ eyebrow, title, action, children }) {
  return (
    <header className="section-head">
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <div className="section-title-row">
        <h2 data-parallax="0.05">{title}</h2>
        {action}
      </div>
      {children && <p>{children}</p>}
    </header>
  );
}

// ======== Marquee ========

// A slow, endless brand strip: short words and longer phrases in large uppercase type, with small caramel separators.
// The list is rendered twice and the track slides exactly one copy to the left, so the loop has no seam. It is pure CSS (no JS, no
// canvas); with reduced motion the second copy is hidden and the words simply sit in a centred, wrapping row.
export const MARQUEE_ITEMS = [
  'Orders', 'Payments', 'Deadlines', 'Inventory', 'Customer messages', 'Production', 'Smart scheduling', 'Business insights', 'Every order, in rhythm',
];

function Set({ items, hidden = false }) {
  return (
    <ul className="mq-set" aria-hidden={hidden || undefined}>
      {items.map((label, i) => (
        <li key={label} className="mq-item">
          <span className="mq-word">{label}</span>
          <i className={`mq-sep ${i % 2 ? 'is-diamond' : 'is-plus'}`} aria-hidden="true" />
        </li>
      ))}
    </ul>
  );
}

export function Marquee({ items = MARQUEE_ITEMS, label = 'What Conversa keeps in rhythm' }) {
  return (
    <section className="mq" aria-label={label}>
      <div className="mq-track">
        <Set items={items} />
        <Set items={items} hidden />
      </div>
    </section>
  );
}

// ======== Edge facets ========

// A few very soft, slowly drifting facets in the brand blues, caramel and cream, kept to the outer edges of the page.
// They sit in the margins beside the dashboard column (never under a card, chart or control) and are hidden altogether when the window
// is too narrow to leave a margin. Purely decorative: aria-hidden, no information, nothing to click. Without WebGL it renders nothing.
const SHAPES = [
  ['ico', '#A9C9EE', 0.9], ['oct', '#E8C5A2', 0.7], ['dod', '#C7DDF5', 1], ['ico', '#C58A52', 0.55], ['oct', '#B8C8F0', 0.85], ['dod', '#F3E3CF', 0.9], ['ico', '#E7F0FB', 1], ['oct', '#D9A36F', 0.5],
];

export function EdgeFacets({ contentWidth = 1240 }) {
  const host = useRef(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    let dead = false; let cleanup = () => {};
    (async () => {
      const THREE = await import('three');
      if (dead || !host.current) return;
      const canvas = document.createElement('canvas'); canvas.setAttribute('aria-hidden', 'true');
      let renderer;
      try { renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true }); } catch { return; }
      host.current.appendChild(canvas);
      renderer.setClearColor(0x000000, 0);
      const scene = new THREE.Scene();
      const cam = new THREE.PerspectiveCamera(35, 1, 0.1, 100); cam.position.z = 14;
      scene.add(new THREE.AmbientLight(0xffffff, 0.95));
      const key = new THREE.DirectionalLight(0xffffff, 1.1); key.position.set(-3, 4, 6); scene.add(key);
      const geos = []; const mats = []; const items = [];
      for (const [kind, color, op] of SHAPES) {
        const g = kind === 'ico' ? new THREE.IcosahedronGeometry(1, 0) : kind === 'oct' ? new THREE.OctahedronGeometry(1, 0) : new THREE.DodecahedronGeometry(1, 0);
        const m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, flatShading: true, transparent: true, opacity: 0.5 * op });
        geos.push(g); mats.push(m);
        const mesh = new THREE.Mesh(g, m); scene.add(mesh);
        items.push({ mesh, phase: Math.random() * 6.28, speed: 0.25 + Math.random() * 0.25, spin: (Math.random() - 0.5) * 0.25 });
      }
      let W = 1; let H = 1; let raf = 0; let start = performance.now();
      // Where the content column ends, in pixels from the window's centre. Facets live only beyond it.
      function layout() {
        const rect = host.current.getBoundingClientRect(); W = Math.max(1, rect.width); H = Math.max(1, rect.height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.setSize(W, H, false); cam.aspect = W / H; cam.updateProjectionMatrix();
        const half = Math.min(contentWidth / 2 + 12, W / 2 - 40); const room = W / 2 - half; // free pixels on each side
        const pxToWorld = (2 * Math.tan((cam.fov * Math.PI) / 360) * cam.position.z) / H;
        items.forEach((it, i) => {
          const side = i % 2 ? 1 : -1; const row = Math.floor(i / 2);
          const size = Math.min(room * 0.42, 46) * (0.7 + (i % 3) * 0.18); // radius in px, always smaller than the margin
          it.mesh.scale.setScalar(Math.max(size, 6) * pxToWorld);
          const xPx = half + room * (0.2 + 0.3 * ((i * 37) % 10) / 10) + (side > 0 ? 0 : 0);
          it.base = { x: side * xPx * pxToWorld, y: (H / 2 - (H * (0.14 + 0.2 * row + (side > 0 ? 0.08 : 0)))) * pxToWorld, drift: 10 * pxToWorld };
        });
      }
      function draw(now) {
        raf = 0; const t = (now - start) / 1000;
        for (const it of items) {
          if (!it.base) continue;
          it.mesh.position.set(it.base.x + Math.cos(t * it.speed * 0.8 + it.phase) * it.base.drift * 0.6, it.base.y + Math.sin(t * it.speed + it.phase) * it.base.drift, 0);
          it.mesh.rotation.x = t * it.spin + it.phase; it.mesh.rotation.y = t * it.spin * 1.3;
        }
        renderer.render(scene, cam);
        if (!reduced && !document.hidden) raf = requestAnimationFrame(draw);
      }
      const ro = new ResizeObserver(() => { layout(); if (!raf) raf = requestAnimationFrame(draw); }); ro.observe(host.current); layout();
      const onVis = () => { if (!document.hidden && !raf && !reduced) raf = requestAnimationFrame(draw); }; document.addEventListener('visibilitychange', onVis);
      raf = requestAnimationFrame(draw);
      cleanup = () => {
        cancelAnimationFrame(raf); ro.disconnect(); document.removeEventListener('visibilitychange', onVis);
        geos.forEach((g) => g.dispose()); mats.forEach((m) => m.dispose()); renderer.dispose();
        renderer.getContext()?.getExtension('WEBGL_lose_context')?.loseContext(); canvas.remove();
      };
    })().catch(() => {});
    return () => { dead = true; cleanup(); };
  }, [reduced, contentWidth]);

  return <div ref={host} className="edge-facets" aria-hidden="true" />;
}
