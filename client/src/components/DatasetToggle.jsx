// "Real | Demo": shown only when both exist. Each page shows ONE data set, and says which.
export default function DatasetToggle({ ds }) {
  if (!ds.both) return null;
  return (
    <div className="ds-toggle" role="group" aria-label="Which data to show">
      {[['real', 'Real', ds.counts.real], ['demo', 'Demo', ds.counts.demo]].map(([k, label, n]) => (
        <button key={k} type="button" className={ds.dataset === k ? 'is-on' : ''} aria-pressed={ds.dataset === k} onClick={() => ds.choose(k)}>{label}<b>{n}</b></button>
      ))}
    </div>
  );
}
