import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { MoreVertical, ShoppingBag, Gauge, CalendarDays } from 'lucide-react';
import { scrollToSection } from '../utils/scroll.js';
import { DEMO_MODE } from '../services/api.js';
import '../css/Navbar.css';

const PAGES = [
  { to: '/orders', label: 'Orders', hint: 'Every order, every channel', icon: ShoppingBag },
  { to: '/operations', label: 'Operations', hint: 'Workload, risks, simulation', icon: Gauge },
  { to: '/calendar', label: 'Calendar', hint: 'Deadlines and scheduled work', icon: CalendarDays },
];
export const HOME_SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'today', label: 'Today' },
  { id: 'deadlines', label: 'Deadlines' },
  { id: 'simulation', label: 'What-if' },
  { id: 'inbox', label: 'Inbox' },
];
const TITLES = { '/': 'Overview', '/orders': 'Orders', '/operations': 'Operations', '/calendar': 'Calendar', '/settings': 'Integrations' };

export default function Navbar() {
  const { pathname } = useLocation();
  const home = pathname === '/';
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState('overview');
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const rootRef = useRef(null);

  const close = useCallback((refocus = false) => { setOpen(false); if (refocus) triggerRef.current?.focus(); }, []);
  useEffect(() => { setOpen(false); }, [pathname]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Highlight the home section currently in view.
  useEffect(() => {
    if (!home || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((entries) => {
      const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (hit) setActive(hit.target.id);
    }, { rootMargin: '-25% 0px -60% 0px', threshold: [0, 0.1, 0.5] });
    const watch = () => HOME_SECTIONS.forEach((s) => { const el = document.getElementById(s.id); if (el) io.observe(el); });
    watch();
    const retry = setTimeout(watch, 800); // sections mount after data loads
    return () => { clearTimeout(retry); io.disconnect(); };
  }, [home]);

  const items = () => [...(menuRef.current?.querySelectorAll('a, button') ?? [])];
  function onMenuKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = items();
    const i = list.indexOf(document.activeElement);
    list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
  }
  function onTriggerKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setTimeout(() => items()[0]?.focus(), 30); }
    if (e.key === 'Escape') close();
  }

  const current = home ? (HOME_SECTIONS.find((s) => s.id === active)?.label ?? 'Overview') : TITLES[pathname] ?? '';

  return (
    <nav className="navbar" aria-label="Main" ref={rootRef}>
      <div className="navbar-top">
        <Link to="/" className="wordmark" onClick={() => home && scrollToSection('overview')}>Conversa<span aria-hidden="true">.</span></Link>
        <button type="button" ref={triggerRef} className="menu-trigger" aria-expanded={open} aria-controls="main-menu" aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen(!open)} onKeyDown={onTriggerKey}>
          <MoreVertical size={18} aria-hidden="true" />
        </button>
      </div>
      <p className="you-are-here" aria-live="polite"><i aria-hidden="true" />{current}</p>

      <div id="main-menu" ref={menuRef} className={`menu${open ? ' is-open' : ''}`} onKeyDown={onMenuKey} inert={open ? undefined : ''}>
        <ul className="menu-list">
          {PAGES.map(({ to, label, hint, icon: Icon }) => (
            <li key={to}>
              <NavLink to={to} onClick={() => close()} className="menu-link"><Icon size={17} aria-hidden="true" /><span>{label}<small>{hint}</small></span></NavLink>
            </li>
          ))}
        </ul>
        {home && (
          <>
            <p className="menu-group">On this page</p>
            <ul className="menu-list menu-sections">
              {HOME_SECTIONS.map((s) => (
                <li key={s.id}>
                  <button type="button" className={`menu-link${active === s.id ? ' active' : ''}`} onClick={() => { scrollToSection(s.id); setActive(s.id); close(); }}>{s.label}</button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <p className="navbar-tagline">The AI reads.<br />Rules decide.<br />You approve.</p>
      {DEMO_MODE && <p className="navbar-demo">Demo mode · simulated data</p>}
    </nav>
  );
}
