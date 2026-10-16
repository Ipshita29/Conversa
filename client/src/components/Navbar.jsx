import { NavLink } from 'react-router-dom';
import '../css/Navbar.css';

const links = [
  { to: '/', label: 'Dashboard' },
  { to: '/orders', label: 'Orders' },
  { to: '/operations', label: 'Operations' },
  { to: '/calendar', label: 'Calendar' },
  { to: '/inbox', label: 'Inbox' },
];

export default function Navbar() {
  return (
    <nav className="navbar">
      <span className="navbar-brand">Conversa</span>
      <ul className="navbar-links">
        {links.map(({ to, label }) => (
          <li key={to}>
            <NavLink to={to} end={to === '/'}>{label}</NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
