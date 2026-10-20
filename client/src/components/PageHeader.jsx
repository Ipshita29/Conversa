import DemoBadge from './DemoBadge.jsx';

export default function PageHeader({ title, subtitle, children, demo = true }) {
  return (
    <header className="page-header">
      <div>
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
