export const STATUS_LABEL = { draft: 'Draft', pending: 'Pending', confirmed: 'Confirmed', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' };
export const PAYMENT_LABEL = { unverified: 'Unverified', pending: 'Payment pending', partial: 'Partly paid', verified: 'Verified', rejected: 'Rejected' };
// WhatsApp is the only messaging platform shown. Records that came in through another channel earlier are kept and shown as a plain "Chat".
export const CHANNEL_LABEL = { manual: 'Manual', whatsapp: 'WhatsApp', instagram: 'Chat' };
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
// A <input type="datetime-local"> holds wall-clock time with no zone. These two convert it to and from an instant in the BUSINESS timezone (never the browser's).
const partsIn = (ms, tz) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
export const isoToLocalInput = (iso, tz) => { if (!iso) return ''; const p = partsIn(Date.parse(iso), tz); const z = (n) => String(n).padStart(2, '0'); return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`; };
export const localInputToIso = (value, tz) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value ?? ''); if (!m) return null;
  const want = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]); let guess = want;
  for (let i = 0; i < 2; i++) { const p = partsIn(guess, tz); guess -= Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - want; } // correct by the zone's offset at that moment
  return new Date(guess).toISOString();
};
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
// The scheduler's "could you take a rush order?" check adds a stand-in order (customer "New customer", item "Rush order") to test capacity. It is not a real
// customer's order, so the Orders gallery does not show it as one (its record is untouched); rush availability is shown by the banner instead.
export const isRushPlaceholder = (o) => o?.customerName === 'New customer' && /^rush order$/i.test(String(o?.item ?? '').trim());
export const OPEN = ['pending', 'confirmed', 'in_progress'];
export const formatLongInTz = (iso, tz) => (iso ? new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '—');
export const formatDayInTz = (isoDate) => new Date(`${isoDate}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });

// One place for the currency. Orders store a plain number (the agreed total), so the symbol is a display choice.
export const CURRENCY = 'INR';
export const formatMoney = (n) => (typeof n === 'number' ? new Intl.NumberFormat(undefined, { style: 'currency', currency: CURRENCY, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n) : '—');
