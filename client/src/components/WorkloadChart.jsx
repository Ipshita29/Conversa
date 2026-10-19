// Dependency-free SVG bar chart: planned hours per day vs. daily capacity.
export default function WorkloadChart({ daily }) {
  const W = 420, H = 200, pad = { t: 12, r: 8, b: 28, l: 28 };
  const max = Math.max(...daily.map((d) => Math.max(d.hours, d.capacity)), 1);
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const slot = innerW / daily.length;
  const barW = slot * 0.55;
  const y = (v) => pad.t + innerH - (v / max) * innerH;
  const summary = daily.map((d) => `${d.label}: ${d.hours}h of ${d.capacity}h`).join(', ');

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Daily workload. ${summary}`}>
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line className="chart-grid" x1={pad.l} x2={W - pad.r} y1={y(max * t)} y2={y(max * t)} />
            <text className="chart-axis" x={pad.l - 6} y={y(max * t) + 4} textAnchor="end">
              {Math.round(max * t)}
            </text>
          </g>
        ))}
        {daily.map((d, i) => {
          const x = pad.l + i * slot + (slot - barW) / 2;
          const over = d.hours > d.capacity;
          return (
            <g key={d.label}>
              <rect className={over ? 'chart-bar over' : 'chart-bar'} x={x} y={y(d.hours)} width={barW} height={innerH - (y(d.hours) - pad.t)} rx="4" />
              <line className="chart-cap" x1={x - 4} x2={x + barW + 4} y1={y(d.capacity)} y2={y(d.capacity)} />
              <text className="chart-axis" x={x + barW / 2} y={H - 8} textAnchor="middle">{d.label}</text>
            </g>
          );
        })}
      </svg>
      <ul className="chart-legend">
        <li><i className="swatch ok" /> Planned hours</li>
        <li><i className="swatch over" /> Over capacity</li>
        <li><i className="swatch cap" /> Daily capacity</li>
      </ul>
    </div>
  );
}
