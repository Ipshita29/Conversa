import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, ShoppingBag, Gauge, CalendarDays, Inbox, Settings, Menu, X } from 'lucide-react';
import { DEMO_MODE } from '../services/api.js';
import '../css/Navbar.css';

const links = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/orders', label: 'Orders', icon: ShoppingBag },
  { to: '/operations', label: 'Operations', icon: Gauge },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays },
  { to: '/inbox', label: 'Inbox', icon: Inbox },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export default function Navbar() {
  const [open, setOpen] = useState(false);
  return (
    <nav className={`navbar${open ? ' is-open' : ''}`} aria-label="Main">
      <div className="navbar-top">
        <span className="navbar-brand">Conversa</span>
        <button type="button" className="navbar-toggle" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Toggle menu">
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
      </div>
      <ul className="navbar-links">
        {links.map(({ to, label, icon: Icon }) => (
          <li key={to}>
            <NavLink to={to} end={to === '/'} onClick={() => setOpen(false)}><Icon size={18} aria-hidden="true" />{label}</NavLink>
          </li>
        ))}
      </ul>
      {DEMO_MODE && <p className="navbar-demo">Demo mode<br /><small>Simulated data. Changes reset on reload.</small></p>}
    </nav>
  );
}
