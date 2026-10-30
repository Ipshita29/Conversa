import '../css/Marquee.css';

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

export default function Marquee({ items = MARQUEE_ITEMS, label = 'What Conversa keeps in rhythm' }) {
  return (
    <section className="mq" aria-label={label}>
      <div className="mq-track">
        <Set items={items} />
        <Set items={items} hidden />
      </div>
    </section>
  );
}
