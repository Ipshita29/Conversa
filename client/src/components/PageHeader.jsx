import DemoBadge from './DemoBadge.jsx';

export default function PageHeader({ eyebrow, title, subtitle, children, demo = true }) {
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
