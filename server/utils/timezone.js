// Minimal IANA-timezone helpers built on Intl (no dependencies).
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const cache = new Map();

function formatter(tz) {
  if (!cache.has(tz)) {
    cache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }));
  }
  return cache.get(tz);
}

export function isValidTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return typeof tz === 'string' && tz.length > 0; } catch { return false; }
}

// Wall-clock parts of an instant in a timezone.
export function zonedParts(date, tz) {
  const p = {};
  for (const { type, value } of formatter(tz).formatToParts(date)) p[type] = value;
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second), weekday: WEEKDAYS[p.weekday],
  };
}

const offsetMs = (date, tz) => {
  const p = zonedParts(date, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
};

// Wall-clock time in a timezone -> UTC instant (handles DST by re-checking the offset).
export function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0 }, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = offsetMs(new Date(guess), tz);
  let t = guess - first;
  const second = offsetMs(new Date(t), tz);
  if (second !== first) t = guess - second;
  return new Date(t);
}

export function addDays({ year, month, day }, n) {
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export const weekdayOf = ({ year, month, day }) => new Date(Date.UTC(year, month - 1, day)).getUTCDay();
const p2 = (n) => String(n).padStart(2, '0');
export const ymdString = ({ year, month, day }) => `${year}-${p2(month)}-${p2(day)}`;
export const parseHm = (hm) => { const [h, m] = hm.split(':').map(Number); return { hour: h, minute: m }; };

export function formatInZone(date, tz) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}
