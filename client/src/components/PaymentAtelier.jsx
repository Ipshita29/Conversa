import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { animate, AnimatePresence, motion } from 'framer-motion';
import { Check, Maximize2, Search } from 'lucide-react';
import { formatMoney } from '../utils/format.js';
import usePrefersReducedMotion from '../hooks/usePrefersReducedMotion.js';
import { METHOD, REC_STATUS, recStatus } from './Payments.jsx';
import '../css/PaymentAtelier.css';

// ======== Payment Atelier: the page's visual layer ========
// Everything here is drawn from the ledger the page already loads (kpis, rows, payments, screenshots). Nothing is computed that the server
// does not already compute, and nothing verifies a payment: the Verify buttons hand over to the existing verification dialog.

const CollectionRings = lazy(() => import('./PaymentScenes.jsx').then((m) => ({ default: m.CollectionRings })));
const ReceiptDesk = lazy(() => import('./PaymentScenes.jsx').then((m) => ({ default: m.ReceiptDesk })));
const Atmosphere = lazy(() => import('./PaymentScenes.jsx').then((m) => ({ default: m.Atmosphere })));

// 3D is an enhancement: not with reduced motion, not without WebGL, not on low-powered devices.
function useThree() {
  const reduced = usePrefersReducedMotion();
  const [ok] = useState(() => {
    try {
      if ((navigator.hardwareConcurrency ?? 8) <= 2 || (navigator.deviceMemory ?? 8) <= 2) return false;
      const c = document.createElement('canvas'); return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
    } catch { return false; }
  });
  return ok && !reduced;
}

export const shortId = (id) => `#${/^[a-f\d]{24}$/i.test(String(id)) ? String(id).slice(-6).toUpperCase() : String(id).replace(/^ord_/, '')}`;
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : null);
const pct = (n) => `${Math.round(n * 100)}%`;

// An amount that eases from its old value to its new one (instantly with reduced motion).
function Money({ value }) {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(reduced ? value : 0);
  const prev = useRef(reduced ? value : 0);
  useEffect(() => {
    if (reduced) { setShown(value); prev.current = value; return undefined; }
    const c = animate(prev.current, value, { duration: 1.1, ease: [0.22, 0.61, 0.36, 1], onUpdate: setShown, onComplete: () => { prev.current = value; } });
    return () => c.stop();
  }, [value, reduced]);
  return <span aria-label={formatMoney(value)}>{formatMoney(Math.round(shown * 100) / 100)}</span>;
}

export function AtelierBackdrop() {
  const three = useThree();
  return three ? <Suspense fallback={null}><Atmosphere /></Suspense> : null;
}

// ---------- Hero: collection overview ----------
export function AtelierHero({ k, count, onRecord, canRecord }) {
  const three = useThree();
  const billed = k.totalReceived + k.outstanding;
  const share = billed > 0 ? k.totalReceived / billed : 0;
  const waiting = billed > 0 ? Math.min(Math.max(0, 1 - share), k.toVerifyAmount / billed) : 0;
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  return (
    <header className="pa-hero">
      <motion.div className="pa-hero-copy" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease: [0.22, 0.61, 0.36, 1] }}>
        <p className="pa-eyebrow">Payment Atelier</p>
        <h1>Your money, <em>in motion.</em></h1>
        <p className="pa-lead">Every payment, every confirmation, all in one place.</p>
        <p className="pa-context"><span aria-hidden="true" />{today} · {count} {count === 1 ? 'order' : 'orders'} tracked</p>
        <button type="button" className="btn btn-primary pa-record" onClick={onRecord} disabled={!canRecord}>Record payment</button>
      </motion.div>

      <motion.div className="pa-orb" initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.9, delay: 0.1, ease: [0.22, 0.61, 0.36, 1] }}>
        {three
          ? <Suspense fallback={null}><CollectionRings received={k.totalReceived} pending={k.toVerifyAmount} left={k.outstanding} /></Suspense>
          : <FlatRing share={share} waiting={waiting} />}
        <div className="pa-orb-centre" role="img" aria-label={billed > 0 ? `${pct(share)} of ${formatMoney(billed)} collected` : 'Nothing billed yet'}>
          <b>{billed > 0 ? pct(share) : '—'}</b><span>collected</span>
        </div>
        <dl className="pa-orb-key">
          <div className="is-in"><dt>Received</dt><dd>{formatMoney(k.totalReceived)}</dd></div>
          <div className="is-wait"><dt>To verify</dt><dd>{formatMoney(k.toVerifyAmount)}</dd></div>
          <div className="is-left"><dt>Outstanding</dt><dd>{formatMoney(k.outstanding)}</dd></div>
        </dl>
      </motion.div>
    </header>
  );
}

// The same arcs as the 3D rings, flat, for reduced motion and devices without WebGL.
function FlatRing({ share, waiting }) {
  const R = 84; const C = 2 * Math.PI * R;
  return (
    <svg className="pa-flat" viewBox="0 0 200 200" aria-hidden="true">
      <circle cx="100" cy="100" r={R} fill="none" stroke="#DCE7F5" strokeWidth="14" />
      <circle cx="100" cy="100" r={R} fill="none" stroke="#243F73" strokeWidth="14" strokeLinecap="round" strokeDasharray={`${C * share} ${C}`} transform="rotate(-90 100 100)" />
      {waiting > 0 && <circle cx="100" cy="100" r={R} fill="none" stroke="#D9A94E" strokeWidth="14" strokeLinecap="round" strokeDasharray={`${C * waiting} ${C}`} transform={`rotate(${-90 + share * 360} 100 100)`} />}
    </svg>
  );
}

// ---------- Financial overview: three different metrics, not three identical cards ----------
export function AtelierOverview({ k, confirmedCount }) {
  const plural = (n, one, many) => (n === 1 ? one : many);
  return (
    <section className="pa-overview" aria-label="Payment overview">
      <article className="pa-m pa-m-in">
        <p className="pa-label">Total received</p>
        <b className="pa-big"><Money value={k.totalReceived} /></b>
        <p className="pa-note"><Check size={14} aria-hidden="true" /> {confirmedCount} {plural(confirmedCount, 'payment', 'payments')} confirmed by you</p>
      </article>
      <article className="pa-m pa-m-wait">
        <p className="pa-label">Awaiting verification</p>
        <b className="pa-big"><Money value={k.toVerifyAmount} /></b>
        <p className="pa-note">{k.toVerify ? `${k.toVerify} ${plural(k.toVerify, 'payment', 'payments')} to check` : 'Nothing waiting'}</p>
      </article>
      <article className="pa-m pa-m-left">
        <p className="pa-label">Outstanding balance</p>
        <b className="pa-big"><Money value={k.outstanding} /></b>
        <p className="pa-note">{k.outstandingOrders} {plural(k.outstandingOrders, 'order', 'orders')}{k.codDue > 0 ? ` · ${formatMoney(k.codDue)} on delivery` : ''}</p>
      </article>
    </section>
  );
}

// ---------- Verification desk ----------
// `items` are the ledger entries that carry a real screenshot. Selecting one only changes what is shown; Verify opens the existing dialog.
export function VerificationDesk({ items, selectedKey, onSelect, onVerify, onProof, onOpen }) {
  const three = useThree();
  const sel = items.find((i) => i.key === selectedKey) ?? items[0] ?? null;
  const stageItems = useStableItems(items);
  return (
    <section className="pa-desk" aria-labelledby="pa-desk-h">
      <div className="pa-sec-head">
        <h2 id="pa-desk-h">Verification desk</h2>
        <p>Review payment proofs and confirm what has arrived.</p>
      </div>
      {items.length === 0 ? <p className="pa-empty">No payment screenshots yet. When a customer sends one, it will appear here.</p> : (
        <div className="pa-desk-body">
          <div className="pa-desk-scene">
            {three && <Suspense fallback={null}><ReceiptDesk items={stageItems} selectedKey={sel?.key} onSelect={onSelect} /></Suspense>}
            <ul className="pa-strip" aria-label="Payment screenshots">
              {items.map((i) => (
                <li key={i.key}>
                  <button type="button" className={i.key === sel?.key ? 'is-on' : ''} aria-pressed={i.key === sel?.key} onClick={() => onSelect(i.key)}>
                    <img src={i.src} alt="" loading="lazy" /><span>{i.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <AnimatePresence mode="wait">
            {sel && (
              <motion.aside key={sel.key} className="pa-detail" aria-live="polite" initial={{ opacity: 0, x: 22 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -14 }} transition={{ duration: 0.28, ease: [0.22, 0.61, 0.36, 1] }}>
                <p className={`pa-pill is-${sel.tone}`}>{sel.label}</p>
                <h3>{sel.name}</h3>
                <p className="pa-detail-amount">{formatMoney(sel.pay.amount)}</p>
                <dl>
                  <div><dt>Order</dt><dd>{sel.orderId ? `${shortId(sel.orderId)}${sel.product ? ` · ${sel.product}` : ''}` : 'Not matched to an order yet'}</dd></div>
                  <div><dt>Method</dt><dd>{METHOD[sel.pay.method] ?? sel.pay.method}</dd></div>
                  {sel.pay.transactionId && <div><dt>Reference</dt><dd className="pa-mono">{sel.pay.transactionId}</dd></div>}
                  {sel.pay.paidAt && <div><dt>Paid</dt><dd>{when(sel.pay.paidAt)}</dd></div>}
                  <div><dt>Verification</dt><dd>{REC_STATUS[recStatus(sel.pay)]}</dd></div>
                </dl>
                <div className="pa-actions">
                  {sel.actionable
                    ? <button type="button" className="btn btn-primary" onClick={() => onVerify(sel.entry)}>{sel.entry.unmatched ? 'Match to an order' : 'Verify payment'}</button>
                    : <button type="button" className="btn" onClick={() => onOpen(sel.entry)}>Open payment details</button>}
                  <button type="button" className="btn" onClick={() => onProof(sel.src)}><Maximize2 size={15} aria-hidden="true" /> View full receipt</button>
                </div>
                <p className="pa-fine">Verifying records what you checked in your own bank or UPI account.</p>
              </motion.aside>
            )}
          </AnimatePresence>
        </div>
      )}
    </section>
  );
}

// The scene is rebuilt only when the set of screenshots changes, not on every refresh of the ledger.
function useStableItems(items) {
  const sig = items.map((i) => `${i.key}|${i.src}`).join(',');
  const ref = useRef({ sig, v: items.map((i) => ({ key: i.key, src: i.src })) });
  if (ref.current.sig !== sig) ref.current = { sig, v: items.map((i) => ({ key: i.key, src: i.src })) };
  return ref.current.v;
}

// ---------- Filters ----------
export function AtelierBar({ tabs, tab, setTab, q, setQ, counts }) {
  return (
    <div className="pa-bar" role="search">
      <div className="pa-pills" role="tablist" aria-label="Show">
        {tabs.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'is-on' : ''} onClick={() => setTab(key)}>
            {label}<small>{counts[key]}</small>
          </button>
        ))}
      </div>
      <label className="pa-search"><Search size={15} aria-hidden="true" /><span className="sr-only">Search payments</span><input type="search" placeholder="Search customer, order or reference" value={q} onChange={(e) => setQ(e.target.value)} /></label>
    </div>
  );
}

// ---------- Receipt gallery ----------
export function ReceiptGallery({ cards, onOpen, onProof }) {
  return (
    <motion.ul className="pa-gallery" aria-label="Payments" layout>
      <AnimatePresence mode="popLayout" initial={false}>
        {cards.map((c, n) => (
          <motion.li key={c.key} layout className={`pa-card is-${c.tone} v${n % 3}`} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96 }}
            whileHover={{ y: -6, rotate: n % 2 ? 0.5 : -0.5 }} transition={{ type: 'spring', stiffness: 260, damping: 26 }}>
            {c.src
              ? <button type="button" className="pa-card-shot" onClick={() => onProof(c.src)} aria-label={`View ${c.name}'s payment screenshot full size`}><img src={c.src} alt="" loading="lazy" /></button>
              : <div className="pa-card-shot is-none"><span>No screenshot</span></div>}
            <button type="button" className="pa-card-body" onClick={() => onOpen(c.entry)} aria-label={`${c.name}${c.orderId ? `, order ${shortId(c.orderId)}` : ''}, ${c.label}`}>
              <span className={`pa-pill is-${c.tone}`}>{c.label}</span>
              <b className="pa-card-name">{c.name}</b>
              <small className="pa-card-sub">{c.orderId ? `${shortId(c.orderId)} · ${c.product}` : 'Not matched to an order yet'}</small>
              <span className="pa-card-amount">{c.amount}</span>
              <small className="pa-card-sub">{c.detail}</small>
              <span className="pa-card-method">{c.methods}</span>
            </button>
            {c.actionable && <button type="button" className="btn btn-primary btn-sm pa-card-act" onClick={() => onOpen(c.entry)}>{c.entry.unmatched ? 'Match' : 'Verify'}</button>}
          </motion.li>
        ))}
      </AnimatePresence>
    </motion.ul>
  );
}
