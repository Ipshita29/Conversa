import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import usePrefersReducedMotion from '../hooks/usePrefersReducedMotion.js';
import { attachmentSrc } from '../services/api.js';
import { formatMinutes, formatTimeInTz, STATUS_LABEL, PAYMENT_LABEL } from '../utils/format.js';
import '../css/ProductionStory.css';

// The production sequence as one scroll-driven story: the large step numbers on the left scroll past, and the ONE production card on the right stays where
// it is and swaps to the order that is currently in the middle of the screen. Every time and figure comes from the scheduler's roadmap (`tasks`, built from
// GET /planner) and the orders; nothing is hardcoded. The picture is the order's own newest reference picture (order.referenceImage: the one the customer sent, or
// the one attached to the order), the same one its Orders card shows; an order with none shows its initial.
const pad = (n) => String(n).padStart(2, '0');
const day = (iso, tz) => new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso));
const PRIORITY = { high: { label: 'Needs attention', tone: 'high' }, medium: { label: 'Tight', tone: 'medium' }, low: { label: 'On track', tone: 'low' } };

// An order the roadmap splits across two days is one step here: its first stretch of work, flagged as continuing.
const merge = (rows) => {
  const by = new Map();
  for (const r of rows) { const id = r.mergeKey ?? r.id; const m = by.get(id); if (m) m.more = true; else by.set(id, { ...r }); }
  return [...by.values()];
};
const qty = (t) => (t.quantity > 1 && !new RegExp(`\\b${t.quantity}\\b`).test(t.item) ? ` · ${t.quantity}` : '');

export default function ProductionStory({ tasks: rows, orders, tz }) {
  const tasks = merge(rows);
  const reduced = usePrefersReducedMotion();
  const [active, setActive] = useState(0);
  const steps = useRef([]);
  const byId = Object.fromEntries(orders.map((o) => [o.id, o]));

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    // the step crossing the middle band of the screen is the active one
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) setActive(Number(e.target.dataset.i)); }), { rootMargin: '-45% 0px -45% 0px' });
    steps.current.forEach((n) => n && io.observe(n));
    return () => io.disconnect();
  }, [tasks.length]);

  if (tasks.length === 0) return null;
  const go = (i) => steps.current[i]?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
  const t = tasks[Math.min(active, tasks.length - 1)]; const o = byId[t.id] ?? {};
  const pr = PRIORITY[t.risk] ?? PRIORITY.low;
  const ease = [0.22, 0.61, 0.36, 1];
  const swap = reduced ? { initial: false, animate: {}, exit: {}, transition: { duration: 0 } } : { initial: { opacity: 0, y: 18 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -14 }, transition: { duration: 0.35, ease } };

  return (
    <section className="ps" aria-label="Production sequence">
      <header className="ps-head"><h2>Production <em>sequence</em></h2><p>What to make, in the order the scheduler recommends.</p></header>
      <div className="ps-grid">
        <ol className="ps-steps">
          {tasks.map((s, i) => {
            const on = i === active; const when = `${formatTimeInTz(s.start, tz)} – ${formatTimeInTz(s.end, tz)}`;
            return (
              <li key={s.key} className="ps-step" data-i={i} ref={(n) => { steps.current[i] = n; }} aria-current={on ? 'step' : undefined}>
                <motion.div className="ps-step-in" animate={{ opacity: on ? 1 : 0.3, x: on || reduced ? 0 : -6 }} transition={{ duration: reduced ? 0 : 0.4, ease }}>
                  <span className="ps-num" aria-hidden="true">{pad(i + 1)}</span>
                  <h3>{s.customerName}</h3>
                  <p className="ps-title">{s.item}{qty(s)}</p>
                  <p className="ps-desc">{when}{s.more ? ', then continues the next working day' : ''}. {s.buffer > 0 ? `Done ${formatMinutes(s.buffer)} before it is due.` : s.deadline && Date.parse(s.end) > Date.parse(s.deadline) ? 'Finishes after its deadline.' : 'Finishes right at its deadline.'}</p>
                </motion.div>
              </li>
            );
          })}
        </ol>

        <aside className="ps-card" aria-live="polite">
          <div className="ps-card-top">
            <span className="ps-count"><b>{pad(active + 1)}</b> / {pad(tasks.length)}</span>
            <span className="ps-dots" role="tablist" aria-label="Orders">
              {tasks.map((s, i) => <button key={s.key} type="button" role="tab" aria-selected={i === active} aria-label={`${pad(i + 1)} ${s.customerName}`} className={i === active ? 'is-on' : ''} onClick={() => go(i)} />)}
            </span>
          </div>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={t.key} className="ps-card-body" {...swap}>
              <div className="ps-pic">
                {byId[t.id]?.referenceImage ? <img src={attachmentSrc(byId[t.id].referenceImage)} alt={`Reference picture for ${t.customerName}'s order`} /> : <span aria-hidden="true">{t.customerName.charAt(0)}</span>}
                <i className={`ps-prio is-${pr.tone}`}>{active === 0 && pr.tone === 'low' ? 'Make first' : pr.label}</i>
              </div>
              <h3>{t.customerName}</h3>
              <p className="ps-card-item">{t.item}{qty(t)}</p>
              <dl className="ps-facts">
                <div className="is-wide"><dt>Production</dt><dd>{formatTimeInTz(t.start, tz)} – {formatTimeInTz(t.end, tz)}<small>{day(t.start, tz)}</small></dd></div>
                <div><dt>Preparation</dt><dd>{formatMinutes(t.prep)}</dd></div>
                <div><dt>Delivery</dt><dd>{t.deadline ? formatTimeInTz(t.deadline, tz) : '—'}<small>{t.deadline ? day(t.deadline, tz) : ''}</small></dd></div>
              </dl>
              {o.status && <p className="ps-chips"><span>{STATUS_LABEL[o.status] ?? o.status}</span><span>{PAYMENT_LABEL[o.paymentStatus] ?? o.paymentStatus ?? '—'}</span></p>}
            </motion.div>
          </AnimatePresence>
        </aside>
      </div>
    </section>
  );
}
