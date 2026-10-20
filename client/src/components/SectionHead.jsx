export default function SectionHead({ eyebrow, title, action, children }) {
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
