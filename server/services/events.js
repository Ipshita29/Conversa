// Live updates. The database is the source of truth; this only tells open browsers "something changed, look again", over Server-Sent Events (plain HTTP,
// so it works behind Render/any proxy, and the browser reconnects by itself). Events are tiny (a topic, and for messages the conversation id) and are
// coalesced, so a burst of writes is ONE nudge. A short backlog lets a reconnecting browser catch up on what it missed (Last-Event-ID).
import { log } from '../utils/log.js';

const TOPICS = ['messages', 'orders', 'payments'];
const clients = new Set();
const backlog = []; // { id, topic, conversationId }
let nextId = 1;
const pending = new Map(); // topic -> Set(conversationId)
let timer = null;

function flush() {
  timer = null;
  for (const [topic, convs] of pending) {
    const ev = { id: nextId++, topic, conversationIds: [...convs] };
    backlog.push(ev); if (backlog.length > 200) backlog.shift();
    for (const res of clients) write(res, ev);
  }
  pending.clear();
}
const write = (res, ev) => { try { res.write(`id: ${ev.id}\nevent: change\ndata: ${JSON.stringify({ topic: ev.topic, conversationIds: ev.conversationIds })}\n\n`); } catch { clients.delete(res); } };

// Something changed in `topic` (and, for messages, in these conversations). Safe to call from anywhere; never throws.
export function publish(topic, conversationId = null) {
  if (!TOPICS.includes(topic)) return;
  (pending.get(topic) ?? pending.set(topic, new Set()).get(topic)).add(conversationId ? String(conversationId) : '');
  if (!timer) { timer = setTimeout(flush, 120); timer.unref?.(); }
}

// GET /api/events
export function stream(req, res) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');
  const last = Number(req.get('Last-Event-ID') ?? 0);
  if (last > 0) for (const ev of backlog) if (ev.id > last) write(res, ev); // what happened while it was away
  res.write(`event: hello\ndata: {"latest":${nextId - 1}}\n\n`);
  clients.add(res);
  const beat = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch { /* closed */ } }, 25000); beat.unref?.();
  req.on('close', () => { clearInterval(beat); clients.delete(res); });
}
export const watchers = () => clients.size;

// Every write to a collection announces itself, however it was made (a webhook, the owner, the scheduler, a background scan): models add
// `schema.plugin(announce('orders'))` before they are compiled.
const WRITES = ['save', 'findOneAndUpdate', 'findOneAndDelete', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'insertMany'];
export const announce = (...topics) => (schema) => {
  for (const op of WRITES) {
    schema.post(op, function (res) {
      try {
        const doc = res && !Array.isArray(res) ? res : null;
        const conv = topics.includes('messages') ? (doc?.conversation ?? doc?._id ?? this?.getFilter?.()?.conversation ?? this?.getFilter?.()?._id) : null;
        for (const t of topics) publish(t, t === 'messages' && conv && typeof conv !== 'object' ? conv : t === 'messages' ? conv?.toString?.() : null);
      } catch (e) { log.warn('events', `Could not announce a change: ${e.message}`); }
    });
  }
};
