import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { MoreVertical, House, LayoutGrid, AlarmClock, FlaskConical, Inbox, ShoppingBag } from 'lucide-react';
import { scrollToTop } from '../utils/scroll.js';
import { DEMO_MODE } from '../services/api.js';
import { DemoBadge } from './UI.jsx';
import '../css/Navbar.css';

// ---------- Navbar ----------
// Five places in the menu; messages sit in a small secondary group.
const WORKSPACE = [
  { key: 'overview', to: '/', label: 'Home', hint: 'Your day, organised', icon: House },
  { key: 'orders', to: '/orders', label: 'Orders', hint: 'Every order, every channel', icon: ShoppingBag },
  { key: 'plan', to: '/plan', label: 'Plan', hint: 'What to make, and when', icon: AlarmClock },
  { key: 'insights', to: '/insights', label: 'Insights', hint: 'Your month at a glance', icon: LayoutGrid },
  { key: 'whatif', to: '/whatif', label: 'What-if', hint: 'Test a change first', icon: FlaskConical },
];
const PAGES = [
  { key: 'inbox', to: '/inbox', label: 'Messages', hint: 'Chats from every channel', icon: Inbox },
];
const TITLES = { '/': 'Home', '/plan': 'Plan', '/whatif': 'What-if', '/inbox': 'Messages', '/orders': 'Orders', '/insights': 'Insights', '/settings': 'Integrations' };
// Sections the pill follows while you scroll a page.
const SPY = {};

export function Navbar() {
  const { pathname, hash } = useLocation();
  const navigate = useNavigate();
  const spy = SPY[pathname];
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const rootRef = useRef(null);
  const lockUntil = useRef(0); // while a click-initiated scroll runs, the pill keeps the chosen label instead of flickering

  const close = useCallback((refocus = false) => { setOpen(false); if (refocus) triggerRef.current?.focus(); }, []);
  useEffect(() => { setOpen(false); setActive(null); }, [pathname, hash]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // On pages with named sections, follow the one in view (drives the pill label and the highlighted What-if item).
  useEffect(() => {
    if (!spy || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((entries) => {
      if (Date.now() < lockUntil.current) return;
      const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (hit) setActive(hit.target.id);
    }, { rootMargin: '-25% 0px -60% 0px', threshold: [0, 0.1, 0.5] });
    const watch = () => Object.keys(spy).forEach((id) => { const el = document.getElementById(id); if (el) io.observe(el); });
    watch();
    const retry = setTimeout(watch, 800); // sections mount after data loads
    return () => { clearTimeout(retry); io.disconnect(); };
  }, [spy]);

  // Same page + no hash: scroll to the top. Otherwise let the router navigate (pages scroll to #hash themselves).
  function onItem(e, to) {
    close();
    lockUntil.current = Date.now() + 1500;
    const [path, h] = to.split('#');
    if (h) setActive(h);
    if (path === pathname) {
      e.preventDefault();
      navigate(to); // also drops a stale #hash from the URL
      if (!h) { setActive(null); scrollToTop(); }
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

  const current = (spy && active && spy[active]) || TITLES[pathname] || '';

  return (
    <nav className="navbar" aria-label="Main" ref={rootRef} onBlur={onBlur}>
      <div className="navbar-pill">
        <button type="button" ref={triggerRef} className="menu-trigger" aria-expanded={open} aria-controls="main-menu" aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen(!open)} onKeyDown={onTriggerKey}>
          <MoreVertical size={20} aria-hidden="true" />
        </button>
        <Link to="/" className="wordmark" onClick={(e) => onItem(e, '/')}>Conversa<span aria-hidden="true">.</span></Link>
        <p className="you-are-here" aria-live="polite"><i aria-hidden="true" />{current}</p>
      </div>

      <div id="main-menu" ref={menuRef} className={`menu${open ? ' is-open' : ''}`} role="group" aria-label="Navigation menu" data-lenis-prevent onKeyDown={onMenuKey} inert={open ? undefined : ''}>
        <p className="menu-group" id="menu-workspace">Workspace</p>
        <ul className="menu-list" aria-labelledby="menu-workspace">
          {WORKSPACE.map((item) => {
            const on = isOn(item); const Icon = item.icon;
            return (
              <li key={item.key}>
                <Link to={item.to} className={`menu-link${on ? ' active' : ''}`} aria-current={on ? (item.key === 'simulation' ? 'location' : 'page') : undefined} onClick={(e) => onItem(e, item.to)}>
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
    </nav>
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
