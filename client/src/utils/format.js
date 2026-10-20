export const STATUS_LABEL = { pending: 'Pending', confirmed: 'Confirmed', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' };
export const PAYMENT_LABEL = { unverified: 'Unverified', pending: 'Payment pending', verified: 'Verified', rejected: 'Rejected' };
export const CHANNEL_LABEL = { manual: 'Manual', whatsapp: 'WhatsApp', instagram: 'Instagram' };
export const RISK_LABEL = { low: 'Low risk', medium: 'Medium risk', high: 'High risk' };

export function formatMinutes(m) {
  if (m === null || m === undefined) return '—';
  const h = Math.floor(m / 60);
  const min = m % 60;
  if (!h) return `${min}m`;
  return min ? `${h}h ${min}m` : `${h}h`;
}

export const formatDateTime = (iso) =>
  iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : 'No deadline';

export const formatDate = (isoDate) =>
  new Date(`${isoDate}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

export const weekday = (isoDate) => new Date(`${isoDate}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short' });

export function timeLeft(iso) {
  if (!iso) return 'No deadline';
  const h = Math.round((new Date(iso) - Date.now()) / 36e5);
  if (h < 0) return 'Overdue';
  return h < 24 ? `${h}h left` : `${Math.round(h / 24)}d left`;
}

// <input type="datetime-local"> works in local time without a zone.
export function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

// ---- Business-timezone helpers (the server returns planner dates in the seller's business timezone) ----
export const greeting = (d = new Date()) => (d.getHours() < 12 ? 'Good morning' : d.getHours() < 18 ? 'Good afternoon' : 'Good evening');
export const dateKey = (iso, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
export const formatInTz = (iso, tz) => (iso ? new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '—');
export const formatTimeInTz = (iso, tz) => (iso ? new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '—');
export function relativeTime(iso) {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
export const isDemoOrder = (o) => typeof o?.notes === 'string' && o.notes.startsWith('[DEMO]');
export const OPEN = ['pending', 'confirmed', 'in_progress'];
