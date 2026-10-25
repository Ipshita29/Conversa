// "90" -> "1h 30m". The same wording the scheduler's explanations use.
export function formatMinutes(m) {
  if (m == null) return '—';
  const h = Math.floor(Math.abs(m) / 60); const r = Math.round(Math.abs(m) % 60);
  return h ? `${h}h${r ? ` ${r}m` : ''}` : `${r}m`;
}
