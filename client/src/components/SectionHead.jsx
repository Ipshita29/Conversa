export default function SectionHead({ eyebrow, title, children }) {
  return (
    <header className="section-head">
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h2>{title}</h2>
      {children && <p>{children}</p>}
    </header>
  );
}
