import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Menu, Hexagon, ArrowUpRight, House, LayoutGrid, AlarmClock, FlaskConical, Inbox, ShoppingBag } from 'lucide-react';
import { scrollToTop } from '../utils/scroll.js';
import { DEMO_MODE } from '../services/api.js';
import { DemoBadge } from './UI.jsx';
import '../css/Navbar.css';

// ---------- Navbar ----------
// A centred floating pill, as in the Conversa design: wordmark, the places you go most, and one blue call to action.
// The same places (plus Integrations and the demo note) live in the popover menu, which is also the whole navigation on small screens.
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
              <ul><li><Link to="/orders">Orders</Link></li><li><Link to="/plan">Plan</Link></li><li><Link to="/insights">Insights</Link></li><li><Link to="/whatif">What-if</Link></li></ul>
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
