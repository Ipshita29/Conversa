import { API_BASE_URL, DEMO_MODE } from './api.js';

// One shared Server-Sent Events connection to GET /api/events. The server only says "orders / payments / messages changed"; each page then reads the
// database again, so the database stays the single source of truth and nothing is patched in the browser. EventSource reconnects by itself and the
// server replays what was missed; after any reconnect every listener is also told to look again ("resync"), in case the backlog was not enough.
const listeners = new Set(); let es = null; let opened = false;

function connect() {
  if (es || DEMO_MODE || typeof EventSource === 'undefined') return;
  es = new EventSource(`${API_BASE_URL}/events`);
  es.addEventListener('change', (e) => { try { const d = JSON.parse(e.data); listeners.forEach((l) => l.topics.includes(d.topic) && l.fn(d)); } catch { /* ignore a malformed event */ } });
  es.addEventListener('hello', () => { if (opened) listeners.forEach((l) => l.fn({ topic: 'resync' })); opened = true; });
}

// topics: 'messages' | 'orders' | 'payments'. Returns the unsubscribe function.
export function onChange(topics, fn) {
  const l = { topics, fn }; listeners.add(l); connect();
  return () => { listeners.delete(l); if (listeners.size === 0 && es) { es.close(); es = null; opened = false; } };
}
