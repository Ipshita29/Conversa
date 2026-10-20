import { DEMO_MODE } from '../services/api.js';

// Renders only in demo mode so simulated data is never mistaken for live data.
export default function DemoBadge({ label = 'Demo data' }) {
  if (!DEMO_MODE) return null;
  return <span className="demo-badge" title="Simulated by the in-browser mock backend (src/mock)">{label}</span>;
}
