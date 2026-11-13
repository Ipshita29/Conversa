import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { X, AlertTriangle, Check, MessageSquare, Paperclip, RotateCcw, ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { assignPayment, confirmPayment, proofSrc, readPaymentScreenshot, recordPayment, refundPayment, rejectPayment, uploadPaymentProof } from '../services/api.js';
import { formatMoney, fromLocalInput, toLocalInput } from '../utils/format.js';
import { Modal } from './UI.jsx';
import { AmountFigures } from './Insights.jsx';
import { validatePaymentInput } from '../../../server/services/paymentLogic.js';
import '../css/Payments.css';

// ======== Payment modal ========

// A large, centred dialog for one order's payments. Closing by clicking outside or pressing Escape is refused while a form is open
// (unsaved changes) or a request is in flight (pending action); the close button is refused only while a request is in flight.
// Panels inside report their state through the guard.
const Guard = createContext({ setDirty() {}, setBusy() {} });
export const useGuard = () => useContext(Guard);

export function PaymentModal({ title, onClose, refreshing = false, children }) {
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(''); // why a close was refused, shown briefly
  const [shake, setShake] = useState(false);
  const box = useRef(null); const closeBtn = useRef(null);
  const noticeTimer = useRef(0);
  const state = useRef({ dirty, busy }); state.current = { dirty, busy };

  const tryClose = useCallback((explicit) => {
    const { dirty: d, busy: b } = state.current;
    if (b || (!explicit && d)) { setNotice(b ? 'Saving… please wait a moment.' : 'Finish or cancel the open form first.'); setShake(true); setTimeout(() => setShake(false), 420); clearTimeout(noticeTimer.current); noticeTimer.current = setTimeout(() => setNotice(''), 3200); return; } // refused: shake the dialog and say why
    onClose();
  }, [onClose]);

  useEffect(() => {
    const before = document.activeElement;
    closeBtn.current?.focus();
    document.documentElement.classList.add('pm-lock');
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); if (!document.querySelector('.payments .modal-backdrop')) tryClose(false); return; } // a screenshot viewer or form on top closes first
      if (e.key !== 'Tab' || !box.current) return;
      const f = [...box.current.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0]; const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { clearTimeout(noticeTimer.current); document.removeEventListener('keydown', onKey); document.documentElement.classList.remove('pm-lock'); before?.focus?.(); };
  }, [tryClose]);

  const guard = useMemo(() => ({ setDirty, setBusy }), []);
  return (
    <Guard.Provider value={guard}>
      <div className="pm-backdrop" data-lenis-prevent onMouseDown={(e) => e.target === e.currentTarget && tryClose(false)}>
        <div className={`pm-modal${shake ? ' is-nudged' : ''}`} ref={box} role="dialog" aria-modal="true" aria-label={title}>
          <button type="button" ref={closeBtn} className="pm-x" onClick={() => tryClose(true)} aria-label="Close payment details" disabled={busy}><X size={18} aria-hidden="true" /></button>
          <div className="pm-modal-body" data-lenis-prevent>{children}</div>
          <p className="pm-modal-live" role="status" aria-live="polite">{notice || (refreshing && !busy ? 'Updating…' : '')}</p>
        </div>
      </div>
    </Guard.Provider>
  );
}

// ======== Payments ========

export const STATUS = { paid: 'Paid', partial: 'Partially paid', due: 'Due', cod: 'COD', verification_pending: 'Verification pending' };
export const METHOD = { upi: 'UPI', bank_transfer: 'Bank transfer', cash: 'Cash', cod: 'COD', other: 'Other' };
export const SOURCE = { manual: 'Entered manually', chat_text: 'From a chat message', chat_screenshot: 'From a chat screenshot', screenshot_upload: 'From an uploaded screenshot', auto_screenshot: 'Automatically detected from Messages' };
// What a record is called: read and matched are not the same as verified, and only the owner's confirmation says Verified.
export const REC_STATUS = { pending_review: 'Pending Review', awaiting_verification: 'Awaiting Verification', verified: 'Verified', rejected: 'Rejected' };
export const recStatus = (p) => p.displayStatus ?? (p.status === 'confirmed' ? 'verified' : p.status === 'rejected' ? 'rejected' : 'awaiting_verification');
export const RecPill = ({ p }) => <em className={`pm-pill is-rec-${recStatus(p)}`}>{REC_STATUS[recStatus(p)]}</em>;
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
const shortId = (id) => `#${/^[a-f\d]{24}$/i.test(String(id)) ? String(id).slice(-6).toUpperCase() : String(id).replace(/^ord_/, '')}`;
const REVIEWER_KEY = 'conversa.reviewer';
const savedReviewer = () => { try { return localStorage.getItem(REVIEWER_KEY) ?? ''; } catch { return ''; } };
const saveReviewer = (v) => { try { localStorage.setItem(REVIEWER_KEY, v); } catch { /* private mode */ } };

// While a panel is saving, the modal refuses to close.
function useBusy(busy) { const g = useGuard(); useEffect(() => { g.setBusy(busy); return () => g.setBusy(false); }, [busy]); } // eslint-disable-line react-hooks/exhaustive-deps

export const StatusPill = ({ status }) => <span className={`pm-pill is-${status}`}>{STATUS[status] ?? status}</span>;

export function Kpis({ kpis }) {
  const cards = [
    ['Total received', formatMoney(kpis.totalReceived), 'Confirmed payments, less refunds', 'is-blue'],
    ['Outstanding', formatMoney(kpis.outstanding), `${kpis.outstandingOrders} ${kpis.outstandingOrders === 1 ? 'order' : 'orders'} still owe money${kpis.codDue > 0 ? ` · ${formatMoney(kpis.codDue)} on delivery` : ''}`, 'is-caramel'],
    ['Partially paid', String(kpis.partiallyPaid), kpis.partiallyPaid ? `${formatMoney(kpis.partialBalance)} still to collect` : 'No part-paid orders', ''],
    ['Payments to verify', String(kpis.toVerify), kpis.toVerify ? `${formatMoney(kpis.toVerifyAmount)} claimed, not yet confirmed` : 'Nothing waiting', kpis.toVerify ? 'is-alert' : ''],
  ];
  return (
    <ul className="pm-kpis">
      {cards.map(([label, value, note, tone]) => <li key={label} className={`pm-kpi ${tone}`}><p>{label}</p><b>{value}</b><small>{note}</small></li>)}
    </ul>
  );
}

// The customer's own message the screenshot arrived in, with a way back to the conversation.
export function SourceMessage({ m }) {
  if (!m) return null;
  return (
    <div className="pm-srcmsg"><MessageSquare size={14} aria-hidden="true" />
      <div><p><b>{m.customerName ?? 'A customer'}</b> · {m.channel === 'instagram' ? 'Instagram' : 'WhatsApp'} · {when(m.at)}</p>
        <p className="pm-srcmsg-text">{m.text ? `“${m.text}”` : 'A picture with no text.'}</p>
        <Link className="pm-link" to={`/inbox?conversation=${m.conversationId}`}>Open the message</Link></div></div>
  );
}

// Three separate facts about an automatically detected payment. Reading and matching never make it verified.
function Stages({ p }) {
  if (!p.match) return null;
  const matched = p.match.state === 'matched';
  return (
    <ol className="pm-stages" aria-label="Where this payment stands">
      <li className="is-done"><Check size={12} aria-hidden="true" /> Read from screenshot</li>
      <li className={matched ? 'is-done' : 'is-warn'}>{matched ? <Check size={12} aria-hidden="true" /> : <AlertTriangle size={12} aria-hidden="true" />} {matched ? 'Matched to order' : 'Match needs review'}</li>
      <li className={p.status === 'confirmed' ? 'is-done' : ''}>{p.status === 'confirmed' ? <Check size={12} aria-hidden="true" /> : null} {p.status === 'confirmed' ? 'Verified by you' : p.status === 'rejected' ? 'Rejected' : 'Not verified yet'}</li>
    </ol>
  );
}

export function ProofThumb({ proof, onOpen, size = 'sm' }) {
  const src = proofSrc(proof);
  if (!src) return <span className="pm-noproof">—</span>;
  return <button type="button" className={`pm-thumb is-${size}`} onClick={(e) => { e.stopPropagation(); onOpen(src); }} aria-label="View payment screenshot"><img src={src} alt="" loading="lazy" /></button>;
}

export function ProofViewer({ src, onClose }) {
  return <Modal variant="lightbox" title="Payment screenshot" onClose={onClose}><div className="pm-proof-big"><img src={src} alt="Payment screenshot sent by the customer" /></div><p className="pm-fine">The original file, exactly as it was received. A screenshot does not prove the money reached your account.</p></Modal>;
}

// ---- Detail drawer content ------------------------------------------------------------------------------------------------
function Facts({ rows }) {
  return <dl className="pm-facts">{rows.filter(Boolean).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

function ConfirmPanel({ payment, row, onDone, onCancel, onProof }) {
  const otherPaid = row.paid;
  const [f, setF] = useState({ amount: String(payment.amount), transactionId: payment.transactionId ?? '', reviewer: savedReviewer(), acknowledged: false, noReference: false });
  const [err, setErr] = useState({}); const [busy, setBusy] = useState(false); const [fail, setFail] = useState(null);
  useBusy(busy);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const amount = Number(f.amount);
  const left = row.balance === null ? null : Math.max(0, Math.round((row.balance - (Number.isFinite(amount) ? amount : 0)) * 100) / 100);
  const needsRef = !['cod', 'cash'].includes(payment.method);

  async function submit(e) {
    e.preventDefault();
    const x = {};
    if (!(amount > 0)) x.amount = 'Enter the amount that actually arrived.';
    if (row.balance !== null && amount - row.balance > 0.005) x.amount = `At most ${formatMoney(row.balance)} is still owed on this order.`;
    if (!f.reviewer.trim()) x.reviewer = 'Enter your name.';
    if (needsRef && !f.transactionId.trim() && !f.noReference) x.transactionId = 'Enter the transaction ID, or tick “No reference available”.';
    if (!f.acknowledged) x.acknowledged = 'Tick to confirm you have checked.';
    setErr(x); if (Object.keys(x).length) return;
    setBusy(true); setFail(null);
    try { saveReviewer(f.reviewer.trim()); await confirmPayment(payment.id, { amount, transactionId: f.transactionId.trim() || null, noReference: f.noReference, reviewer: f.reviewer.trim(), acknowledged: true }); onDone(); }
    catch (er) { setFail(er); } finally { setBusy(false); }
  }
  const fe = (k) => err[k] && <span className="field-note error" role="alert">{err[k]}</span>;
  const dupErr = fail?.details?.find((d) => d.field === 'transactionId')?.message;
  return (
    <form className="pm-confirm" onSubmit={submit} noValidate>
      <h4>{payment.method === 'cod' ? 'Confirm cash collected' : 'Confirm payment'}</h4>
      <div className="pm-confirm-top">
        {payment.proof && <ProofThumb proof={payment.proof} onOpen={onProof} size="lg" />}
        <div className="pm-sums">
          <p><span>Order total</span><b>{row.total === null ? 'Not priced' : formatMoney(row.total)}</b></p>
          <p><span>Already confirmed</span><b>{formatMoney(otherPaid)}</b></p>
          <p><span>Claimed in this payment</span><b>{formatMoney(payment.amount)}</b></p>
          <p className="is-left"><span>Balance after this</span><b>{left === null ? '—' : formatMoney(left)}</b></p>
        </div>
      </div>
      {payment.extraction && <Extraction x={payment.extraction} />}
      <div className="form-grid">
        <label className="field"><span className="field-label">Amount that arrived *</span><input type="number" min="0" step="0.01" value={f.amount} onChange={set('amount')} />{fe('amount')}</label>
        {needsRef && <label className="field"><span className="field-label">Transaction / reference ID</span><input value={f.transactionId} onChange={set('transactionId')} disabled={f.noReference} />{fe('transactionId') ?? (dupErr && <span className="field-note error" role="alert">{dupErr}</span>)}</label>}
        <label className="field"><span className="field-label">Your name (recorded) *</span><input value={f.reviewer} onChange={set('reviewer')} autoComplete="name" />{fe('reviewer')}</label>
        {needsRef && <label className="pm-check"><input type="checkbox" checked={f.noReference} onChange={set('noReference')} /> No reference available</label>}
      </div>
      <label className="pm-check pm-ack"><input type="checkbox" checked={f.acknowledged} onChange={set('acknowledged')} /> <span>I checked my own bank or UPI account, and the amount and transaction details above match.</span></label>
      {fe('acknowledged')}
      <p className="pm-fine"><ShieldAlert size={13} aria-hidden="true" /> Confirmation is manual. Conversa does not contact your bank or UPI provider, so this only records what you checked.</p>
      {fail && !dupErr && <div className="notice error" role="alert">{fail.message}</div>}
      <div className="form-actions"><button type="button" className="btn" onClick={onCancel}>Back</button><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Confirm payment'}</button></div>
    </form>
  );
}

function Extraction({ x }) {
  const pct = x.confidence == null ? null : Math.round(x.confidence * 100);
  return (
    <div className="pm-extract">
      <p><b>Read automatically</b> · {x.method === 'vision' ? 'from a screenshot' : x.method === 'text' ? 'from a chat message' : 'by hand'}{pct !== null && <> · confidence {pct}%</>}{x.needsReview && <span className="pm-flag">Needs review</span>}</p>
      {x.recipient && <p className="pm-fine">Recipient shown: {x.recipient}</p>}
      {x.issues?.length > 0 && <ul>{x.issues.map((i) => <li key={i}><AlertTriangle size={12} aria-hidden="true" /> {i}</li>)}</ul>}
    </div>
  );
}

function RejectPanel({ payment, onDone, onCancel }) {
  const [mode, setMode] = useState('needs_review'); const [note, setNote] = useState(''); const [reviewer, setReviewer] = useState(savedReviewer());
  const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  useBusy(busy);
  async function go(e) {
    e.preventDefault();
    if (!reviewer.trim()) return setErr('Enter your name.');
    if (mode === 'reject' && !note.trim()) return setErr('Say briefly why it is rejected.');
    setBusy(true); setErr(null);
    try { saveReviewer(reviewer.trim()); await rejectPayment(payment.id, { mode, reviewer: reviewer.trim(), note: note.trim() || null }); onDone(mode); } catch (er) { setErr(er.message); setBusy(false); }
  }
  return (
    <form className="pm-confirm" onSubmit={go}>
      <h4>Reject or flag for review</h4>
      <div className="pm-seg" role="radiogroup" aria-label="Action">
        {[['needs_review', 'Needs review', 'Keep it waiting, flagged'], ['reject', 'Reject', 'Not received. Frees the transaction ID']].map(([k, l, h]) => <label key={k} className={mode === k ? 'is-on' : ''}><input type="radio" name="mode" checked={mode === k} onChange={() => setMode(k)} /><b>{l}</b><small>{h}</small></label>)}
      </div>
      <label className="field"><span className="field-label">{mode === 'reject' ? 'Reason *' : 'What needs checking?'}</span><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></label>
      <label className="field"><span className="field-label">Your name (recorded) *</span><input value={reviewer} onChange={(e) => setReviewer(e.target.value)} /></label>
      {err && <span className="field-note error" role="alert">{err}</span>}
      <div className="form-actions"><button type="button" className="btn" onClick={onCancel}>Back</button><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : mode === 'reject' ? 'Reject payment' : 'Flag for review'}</button></div>
    </form>
  );
}

function RefundPanel({ payment, onDone, onCancel }) {
  const [f, setF] = useState({ amount: '', reason: '', reviewer: savedReviewer() }); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  useBusy(busy);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  async function go(e) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { saveReviewer(f.reviewer.trim()); await refundPayment(payment.id, { amount: Number(f.amount), reason: f.reason, reviewer: f.reviewer }); onDone(); }
    catch (er) { setErr(er.details?.[0]?.message ?? er.message); setBusy(false); }
  }
  return (
    <form className="pm-confirm" onSubmit={go}>
      <h4>Record a refund or reversal</h4>
      <p className="pm-fine">The original payment stays as it was. A separate refund entry is added and the balance reopens.</p>
      <div className="form-grid">
        <label className="field"><span className="field-label">Amount refunded *</span><input type="number" min="0" step="0.01" max={payment.amount} value={f.amount} onChange={set('amount')} /></label>
        <label className="field"><span className="field-label">Your name (recorded) *</span><input value={f.reviewer} onChange={set('reviewer')} /></label>
      </div>
      <label className="field"><span className="field-label">Reason *</span><input value={f.reason} onChange={set('reason')} maxLength={500} /></label>
      {err && <span className="field-note error" role="alert">{err}</span>}
      <div className="form-actions"><button type="button" className="btn" onClick={onCancel}>Back</button><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Record refund'}</button></div>
    </form>
  );
}

function Record({ p, row, tz, onProof, act, setAct, onChanged, onRejected }) {
  const [adding, setAdding] = useState(false);
  const mine = act?.id === p.id ? act.kind : null;
  const refund = p.kind === 'refund';
  async function attach(e) {
    const file = e.target.files?.[0]; if (!file) return;
    setAdding(true);
    try { await uploadPaymentProof(p.id, file); onChanged(); } catch (er) { window.alert(er.message); } finally { setAdding(false); e.target.value = ''; }
  }
  return (
    <article id={`pm-rec-${p.id}`} className={`pm-rec is-${p.status}${refund ? ' is-refund' : ''}`}>
      <header>
        <div><b>{refund ? '−' : ''}{formatMoney(p.amount)}</b><span> · {refund ? 'Refund' : METHOD[p.method]}</span></div>
        {refund || (p.method === 'cod' && p.status === 'pending') ? <em className={`pm-pill is-rec-${refund ? 'refund' : 'pending'}`}>{refund ? 'Refunded' : 'COD · due on delivery'}</em> : <RecPill p={p} />}
      </header>
      <Stages p={p} />
      <Facts rows={[['Reference', p.transactionId ?? (p.method === 'cod' || p.method === 'cash' ? 'None needed' : '—')], ['Paid', p.paidAt ? when(p.paidAt) : p.method === 'cod' ? 'On delivery' : '—'], ['Source', `${SOURCE[p.source] ?? p.source}${p.isDemo ? ' · demo' : ''}`], p.notes && ['Notes', p.notes]]} />
      {p.proof ? <div className="pm-rec-proof"><ProofThumb proof={p.proof} onOpen={onProof} size="lg" /><span>Original screenshot, kept as received</span></div>
        : !refund && <label className="pm-attach"><Paperclip size={13} aria-hidden="true" /> {adding ? 'Uploading…' : 'Attach screenshot'}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={attach} disabled={adding} /></label>}
      {p.extraction && <Extraction x={p.extraction} />}
      {p.match && p.match.state !== 'matched' && <p className="pm-fine pm-matchnote"><AlertTriangle size={12} aria-hidden="true" /> {p.match.reason}</p>}
      <SourceMessage m={p.sourceMessage} />
      {p.review && <p className="pm-fine pm-review">{p.review.mode === 'confirmed' || p.review.mode === 'manual_entry' ? <Check size={12} aria-hidden="true" /> : null} {p.review.mode === 'rejected' ? 'Rejected' : p.review.mode === 'needs_review' ? 'Flagged' : p.review.mode === 'refund' ? 'Refund recorded' : 'Confirmed manually'} by {p.review.by} · {when(p.review.at)}{p.review.note ? ` · “${p.review.note}”` : ''}</p>}

      {mine === 'confirm' && <ConfirmPanel payment={p} row={row} onProof={onProof} onCancel={() => setAct(null)} onDone={() => { setAct(null); onChanged(); }} />}
      {mine === 'reject' && <RejectPanel payment={p} onCancel={() => setAct(null)} onDone={(mode) => { setAct(null); if (mode === 'reject') onRejected(); onChanged(); }} />}
      {mine === 'refund' && <RefundPanel payment={p} onCancel={() => setAct(null)} onDone={() => { setAct(null); onChanged(); }} />}
      {!mine && p.status === 'pending' && !refund && (
        <div className="pm-rec-actions"><button type="button" className="btn btn-primary btn-sm" onClick={() => setAct({ id: p.id, kind: 'confirm' })}>{p.method === 'cod' ? 'Confirm collected' : 'Confirm payment'}</button><button type="button" className="btn btn-sm" onClick={() => setAct({ id: p.id, kind: 'reject' })}>Reject / Needs review</button></div>
      )}
      {!mine && p.status === 'confirmed' && !refund && <div className="pm-rec-actions"><button type="button" className="pm-link" onClick={() => setAct({ id: p.id, kind: 'refund' })}><RotateCcw size={12} aria-hidden="true" /> Record a refund</button></div>}
      {p.history.length > 0 && (
        <details className="pm-hist"><summary>History ({p.history.length})</summary>
          <ol>{p.history.map((h, i) => <li key={i}><time>{when(h.at)}</time> <b>{h.action.replace(/_/g, ' ')}</b>{h.by ? ` · ${h.by}` : ''}{h.note ? ` — ${h.note}` : ''}</li>)}</ol>
        </details>
      )}
    </article>
  );
}

export function PaymentDetail({ row, tz, onChanged, onRecord, onProof, refreshing = false, initialAct = null }) {
  const [act, setAct] = useState(initialAct); // { id, kind }: opened straight into Verify or Reject from the list
  const [settle, setSettle] = useState(0); // bumped after a rejection so the figures re-settle on the confirmed values
  const guard = useGuard();
  const root = useRef(null);
  // After a confirmation, rejection or refund, return to the amounts so the owner sees them settle.
  const changed = () => { root.current?.closest('.pm-modal-body')?.scrollTo({ top: 0, behavior: 'smooth' }); onChanged(); };
  useEffect(() => { setAct(initialAct); }, [row.orderId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { guard.setDirty(Boolean(act)); return () => guard.setDirty(false); }, [act]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (act) document.getElementById(`pm-rec-${act.id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [act]);

  const waiting = row.payments.filter((p) => p.status === 'pending' && p.kind !== 'refund');
  const verify = waiting.filter((p) => p.method !== 'cod');
  const next = waiting[0] ?? null; // the payment the action bar works on first
  const flagged = row.payments.some((p) => p.status === 'pending' && p.extraction?.needsReview);

  return (
    <div className="pm-detail" ref={root}>
      <header className="pm-mhead">
        <div>
          <h3>{row.customerName}{row.isDemo && <span className="demo-tag">Demo</span>}</h3>
          <p>{row.item} × {row.quantity} · Order <Link to={`/orders?edit=${row.orderId}`}>{shortId(row.orderId)}</Link></p>
        </div>
        <StatusPill status={row.status} />
      </header>

      <AmountFigures settleKey={settle} figures={[
        { key: 'total', label: 'Order total', value: row.total },
        { key: 'paid', label: 'Confirmed paid', value: row.paid },
        { key: 'left', label: 'Remaining balance', value: row.balance },
      ]} />
      {row.refunded > 0 && <p className="pm-fine">Confirmed paid includes {formatMoney(row.refunded)} refunded.</p>}

      {verify.length > 0 && (
        <div className="pm-alert" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div><b>{verify.length === 1 ? 'A payment is waiting for your verification.' : `${verify.length} payments are waiting for your verification.`}</b>
            <p>Until you confirm {verify.length === 1 ? 'it' : 'them'}, the money is not counted as received.{flagged ? ' Some details were read automatically and need a careful check.' : ''}</p></div>
        </div>
      )}
      {row.codDue > 0 && <p className="pm-note">{formatMoney(row.codDue)} is due in cash on delivery. It is not counted as received until you confirm you collected it.</p>}
      {row.legacy && <p className="pm-note">This order was marked paid by hand, with no payment record. Record the payment to keep the history.</p>}

      <section className="pm-history" aria-label="Payment history">
        <h4 className="pm-h4">Payment history</h4>
        {row.payments.length === 0 ? <p className="muted">No payments recorded for this order yet.</p>
          : row.payments.map((p) => <Record key={p.id} p={p} row={row} tz={tz} onProof={onProof} act={act} setAct={setAct} onChanged={changed} onRejected={() => setSettle((n) => n + 1)} />)}
      </section>

      <p className="pm-fine pm-sep">Payment status is separate from production status: recording or confirming a payment never moves the order on the Orders board. Confirmation is manual; Conversa does not contact a bank.</p>

      <footer className="pm-actionbar">
        <div className="pm-actionbar-main">
          {next && <>
            <button type="button" className="btn btn-primary" disabled={Boolean(act) || refreshing} onClick={() => setAct({ id: next.id, kind: 'confirm' })}>{next.method === 'cod' ? 'Confirm collected' : 'Confirm payment'}{waiting.length > 1 ? ` · ${formatMoney(next.amount)}` : ''}</button>
            <button type="button" className="btn" disabled={Boolean(act) || refreshing} onClick={() => setAct({ id: next.id, kind: 'reject' })}>Reject / Needs review</button>
          </>}
          <button type="button" className="btn pm-record" disabled={Boolean(act)} onClick={() => onRecord(row.orderId)}>+ Record another payment</button>
        </div>
        {act ? <span className="pm-actionbar-hint">Finish or go back from the open form above.</span> : refreshing ? <span className="pm-actionbar-hint">Updating…</span> : null}
      </footer>
    </div>
  );
}

// ---- Record payment ------------------------------------------------------------------------------------------------------
export function RecordPayment({ rows, orderId, onClose, onSaved }) {
  const open = rows.filter((r) => r.orderStatus !== 'cancelled');
  const [f, setF] = useState(() => {
    const r = open.find((x) => x.orderId === orderId);
    return { orderId: orderId ?? '', amount: r?.balance ? String(r.balance) : '', method: 'upi', transactionId: '', paidAt: toLocalInput(new Date().toISOString()), notes: '', received: false, reviewer: savedReviewer() };
  });
  const [file, setFile] = useState(null); const [err, setErr] = useState({}); const [busy, setBusy] = useState(false); const [fail, setFail] = useState(null);
  const [reading, setReading] = useState(false); const [read, setRead] = useState(null); const [readFail, setReadFail] = useState(null); // the server's reading of the screenshot
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const row = open.find((r) => r.orderId === f.orderId);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const pickOrder = (e) => { const r = open.find((x) => x.orderId === e.target.value); setF((x) => ({ ...x, orderId: e.target.value, amount: r?.balance ? String(r.balance) : x.amount, method: x.method })); };
  const noRef = f.method === 'cod' || f.method === 'cash';

  // Choosing a screenshot sends it to the server (Groq vision) and fills the form from what it read. Everything stays editable, and
  // if the reading fails the screenshot is simply kept and the owner types the details.
  async function chooseFile(e) {
    const picked = e.target.files?.[0] ?? null;
    setFile(picked); setRead(null); setReadFail(null); setErr((x) => ({ ...x, file: undefined }));
    if (!picked) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(picked.type)) return setErr((x) => ({ ...x, file: 'Upload a PNG, JPEG or WebP image.' }));
    if (picked.size > 5 * 1024 * 1024) return setErr((x) => ({ ...x, file: 'The image is larger than 5 MB.' }));
    setReading(true);
    try {
      const r = await readPaymentScreenshot(picked);
      const x = r.extraction;
      setRead(r);
      setF((cur) => ({ ...cur, amount: String(x.amount), transactionId: x.transactionId ?? cur.transactionId, method: x.paymentMethod ?? cur.method, paidAt: x.paymentDate ? toLocalInput(x.paymentDate) : cur.paidAt, received: false }));
    } catch (er) { setReadFail(er); } finally { setReading(false); }
  }
  const x0 = read?.extraction ?? null;
  const edited = x0 ? Number(f.amount) !== x0.amount || (f.transactionId.trim() || null) !== (x0.transactionId ?? null) || (x0.paymentMethod && f.method !== x0.paymentMethod) : false;

  async function submit(e) {
    e.preventDefault(); setFail(null);
    const body = { orderId: f.orderId, amount: f.amount === '' ? null : Number(f.amount), method: f.method, ...(f.transactionId.trim() && !noRef ? { transactionId: f.transactionId.trim() } : {}), ...(f.paidAt && f.method !== 'cod' ? { paidAt: fromLocalInput(f.paidAt) } : {}), notes: f.notes.trim() || null, confirmed: f.received && !x0, ...(f.received && !x0 ? { reviewer: f.reviewer } : {}),
      ...(x0 ? { extraction: { extractionConfidence: x0.extractionConfidence, warnings: x0.warnings, recipientDetails: x0.recipientDetails, model: x0.model, edited } } : {}) };
    const { details } = validatePaymentInput(body);
    const x = Object.fromEntries(details.map((d) => [d.field, d.message]));
    if (row && row.balance !== null && Number(f.amount) - row.balance > 0.005 && (f.received || f.method === 'cod')) x.amount = `This order only has ${formatMoney(row.balance)} left to pay.`;
    if (read?.duplicate) x.file = 'This exact screenshot is already recorded. Open that payment instead.';
    if (file && !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) x.file = 'Upload a PNG, JPEG or WebP image.';
    if (file && file.size > 5 * 1024 * 1024) x.file = 'The image is larger than 5 MB.';
    setErr(x); if (Object.keys(x).length) return;
    setBusy(true);
    try { if (f.received && !x0) saveReviewer(f.reviewer.trim()); const rec = await recordPayment(body, file); onSaved(rec); }
    catch (er) { if (er.saved) { onSaved(); return; } const m = {}; (er.details ?? []).forEach((d) => { m[d.field] = d.message; }); setErr(m); setFail(er); setBusy(false); }
  }
  const fe = (k) => err[k] && <span className="field-note error" role="alert">{err[k]}</span>;
  return (
    <Modal title="Record payment" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <div className="form-grid">
          <label className="field pm-wide"><span className="field-label">Order *</span>
            <select value={f.orderId} onChange={pickOrder}><option value="">Choose an order…</option>{open.map((r) => <option key={r.orderId} value={r.orderId}>{r.customerName} · {r.item}{r.balance ? ` · ${formatMoney(r.balance)} due` : ''}</option>)}</select>{fe('orderId')}
          </label>
          <label className="field"><span className="field-label">Amount *</span><input type="number" min="0" step="0.01" value={f.amount} onChange={set('amount')} />{fe('amount')}{row?.balance != null && <span className="field-hint">Balance on this order: {formatMoney(row.balance)}</span>}</label>
          <label className="field"><span className="field-label">Method *</span><select value={f.method} onChange={set('method')}>{Object.entries(METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>{fe('method')}</label>
          {!noRef && <label className="field"><span className="field-label">Transaction / reference ID</span><input value={f.transactionId} onChange={set('transactionId')} />{fe('transactionId')}</label>}
          {f.method !== 'cod' && <label className="field"><span className="field-label">Payment date and time</span><input type="datetime-local" value={f.paidAt} onChange={set('paidAt')} />{fe('paidAt')}</label>}
          <div className="field pm-wide pm-shot">
            <label className="field-label" htmlFor="pm-file">Payment screenshot or receipt</label>
            <input id="pm-file" type="file" accept="image/png,image/jpeg,image/webp" onChange={chooseFile} disabled={reading} />
            {fe('file') ?? <span className="field-hint">Choose a screenshot and Conversa reads the amount and reference for you to check. PNG, JPEG or WebP, up to 5 MB, stored privately.</span>}
            {reading && <p className="pm-reading" role="status"><span className="pm-spin" aria-hidden="true" /> Reading the screenshot…</p>}
            {preview && !reading && <div className="pm-shot-row"><img className="pm-shot-img" src={preview} alt="Screenshot you selected" />
              <div>
                {x0 && <div className="pm-extract"><p><b>Read from the screenshot</b> · confidence {Math.round((x0.extractionConfidence ?? 0) * 100)}%<span className="pm-flag">Check before saving</span></p>
                  {x0.recipientDetails && <p className="pm-fine">Recipient shown: {x0.recipientDetails}</p>}
                  {x0.warnings.length > 0 && <ul>{x0.warnings.map((w) => <li key={w}><AlertTriangle size={12} aria-hidden="true" /> {w}</li>)}</ul>}
                  <p className="pm-fine">The fields below are filled in from it. Correct anything that is wrong. It is saved as Verification pending, never as received.</p></div>}
                {read?.duplicate && <div className="notice error" role="alert">This exact screenshot is already recorded ({read.duplicate.status === 'confirmed' ? 'confirmed' : 'waiting for verification'}). <Link to={`/payments?order=${read.duplicate.orderId}`} onClick={onClose}>Open that payment</Link></div>}
                {readFail && <div className="notice info" role="alert">Couldn’t read this screenshot: {readFail.message}{/by hand/.test(readFail.message) ? '' : ' Enter the details yourself.'} The screenshot will still be attached.</div>}
              </div></div>}
          </div>
          <label className="field pm-wide"><span className="field-label">Notes</span><input value={f.notes} onChange={set('notes')} maxLength={500} />{fe('notes')}</label>
        </div>
        {x0 ? <p className="pm-fine">A payment read from a screenshot is always filed as Verification pending. You confirm it afterwards, once you have checked your account.</p>
          : <label className="pm-check pm-ack"><input type="checkbox" checked={f.received} onChange={set('received')} /> <span>{f.method === 'cod' ? 'I have collected this cash.' : 'I checked my account and this money has arrived.'} <small>Leave unticked to file it as “Verification pending”.</small></span></label>}
        {f.received && !x0 && <label className="field"><span className="field-label">Your name (recorded) *</span><input value={f.reviewer} onChange={set('reviewer')} />{fe('reviewer')}</label>}
        {f.method === 'cod' && !f.received && <p className="pm-fine">COD is recorded as due on delivery and is not counted as received until you confirm collection.</p>}
        {fail && !fail.details?.length && <div className="notice error" role="alert">{fail.message}</div>}
        {fail?.code === 'DUPLICATE_TRANSACTION' && <div className="notice error" role="alert">{fail.message}</div>}
        <div className="form-actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy || reading || Boolean(read?.duplicate)}>{busy ? 'Saving…' : f.received && !x0 ? 'Save as received' : 'Save for verification'}</button></div>
      </form>
    </Modal>
  );
}


// ---- Detected from Messages -----------------------------------------------------------------------------------------------
// Payments Conversa found by itself in a customer's picture that no order has claimed yet, newest first. Detected payments that already belong to an order are
// listed once, in the ledger below (marked "Automatically detected from Messages"), not repeated here.
export const detectedFrom = (data) => data.unassigned
  .map((p) => ({ ...p, customerName: p.sourceMessage?.customerName ?? 'Unknown sender', item: null }))
  .sort((a, b) => Date.parse(b.createdAt ?? 0) - Date.parse(a.createdAt ?? 0));

export function DetectedList({ items, onOpen, onProof }) {
  if (!items.length) return null;
  const review = items.filter((p) => recStatus(p) === 'pending_review').length;
  return (
    <section className="pm-detected" aria-label="Payments detected from Messages">
      <header><h2>Unmatched payments from Messages</h2>{review > 0 && <b className="pm-review-count">{review} to review</b>}</header>
      <div className="pm-ledger pm-det" role="table" aria-label="Detected payments">
        <div className="pm-row pm-row-head" role="row">
          <span role="columnheader">Customer</span><span role="columnheader">Order</span><span role="columnheader" className="r">Amount</span><span role="columnheader">Method</span>
          <span role="columnheader">Transaction ID</span><span role="columnheader">Paid on</span><span role="columnheader">Status</span><span role="columnheader">Screenshot</span><span role="columnheader">Source</span>
        </div>
        {items.map((p) => (
          <div key={p.id} role="row" className="pm-row" tabIndex={0} onClick={() => onOpen(p)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(p); } }} aria-label={`${p.customerName}, ${formatMoney(p.amount)}, ${REC_STATUS[recStatus(p)]}. Open.`}>
            <span role="cell" className="pm-who"><b>{p.customerName}</b></span>
            <span role="cell" className="pm-ord" data-l="Order">{p.orderId ? <>{shortId(p.orderId)}<small>{p.item}</small></> : <em className="pm-unmatched">Not matched</em>}</span>
            <span role="cell" className="r" data-l="Amount">{formatMoney(p.amount)}</span>
            <span role="cell" data-l="Method">{METHOD[p.method] ?? p.method}</span>
            <span role="cell" className="pm-txn" data-l="Transaction ID">{p.transactionId ?? '—'}</span>
            <span role="cell" data-l="Paid on">{when(p.paidAt)}</span>
            <span role="cell"><RecPill p={p} /></span>
            <span role="cell"><ProofThumb proof={p.proof} onOpen={onProof} /></span>
            <span role="cell" className="pm-src" data-l="Source">{SOURCE[p.source]}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// A detected payment with no order yet: the owner sees the screenshot and the message, picks the order (suggestions first), or rejects it.
export function AssignPayment({ payment: p, rows, onClose, onSaved }) {
  const open = rows.filter((r) => r.orderStatus !== 'cancelled');
  const suggested = new Set(p.match?.candidates ?? []);
  const sorted = [...open.filter((r) => suggested.has(r.orderId)), ...open.filter((r) => !suggested.has(r.orderId))];
  const [orderId, setOrderId] = useState(suggested.size === 1 ? [...suggested][0] : '');
  const [reviewer, setReviewer] = useState(savedReviewer()); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false); const [proof, setProof] = useState(null); const [rejecting, setRejecting] = useState(false);
  async function go(e) {
    e.preventDefault();
    if (!orderId) return setErr('Choose the order this payment is for.');
    if (!reviewer.trim()) return setErr('Enter your name.');
    setBusy(true); setErr(null);
    try { saveReviewer(reviewer.trim()); await assignPayment(p.id, { orderId, reviewer: reviewer.trim() }); onSaved(orderId); } catch (er) { setErr(er.details?.[0]?.message ?? er.message); setBusy(false); }
  }
  return (
    <Modal title="Which order is this payment for?" onClose={onClose}>
      <div className="pm-assign">
        <div className="pm-assign-top">{p.proof && <ProofThumb proof={p.proof} onOpen={setProof} size="lg" />}
          <div><b>{formatMoney(p.amount)}</b> · {METHOD[p.method]} · <RecPill p={p} />
            <p className="pm-fine">{p.transactionId ? `Reference ${p.transactionId}` : 'No reference was read.'} · {when(p.paidAt)}</p></div></div>
        <p className="pm-matchnote"><AlertTriangle size={13} aria-hidden="true" /> {p.match?.reason ?? 'No order could be matched.'} Nothing was assigned automatically.</p>
        <SourceMessage m={p.sourceMessage} />
        {p.extraction && <Extraction x={p.extraction} />}
        {rejecting ? <RejectPanel payment={p} onCancel={() => setRejecting(false)} onDone={() => onSaved(null)} /> : (
          <form onSubmit={go} noValidate>
            <label className="field"><span className="field-label">Order *</span>
              <select value={orderId} onChange={(e) => setOrderId(e.target.value)}><option value="">Choose an order…</option>
                {sorted.map((r) => <option key={r.orderId} value={r.orderId}>{suggested.has(r.orderId) ? 'Suggested · ' : ''}{r.customerName} · {r.item}{r.balance ? ` · ${formatMoney(r.balance)} due` : ''}</option>)}</select></label>
            <label className="field"><span className="field-label">Your name (recorded) *</span><input value={reviewer} onChange={(e) => setReviewer(e.target.value)} autoComplete="name" /></label>
            {err && <span className="field-note error" role="alert">{err}</span>}
            <p className="pm-fine">Choosing the order does not verify the payment. You still confirm it once you have checked your account.</p>
            <div className="form-actions"><button type="button" className="btn" onClick={() => setRejecting(true)}>Reject</button><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Assign to this order'}</button></div>
          </form>)}
      </div>
      {proof && <ProofViewer src={proof} onClose={() => setProof(null)} />}
    </Modal>
  );
}

// ---- Needs action -----------------------------------------------------------------------------------------------------------
// One compact list of everything the owner has to do by hand, built from the ledger (and unreadable screenshots from Messages).
// Nothing here marks money as received: Verify only opens the confirmation form, where the owner checks the details first.
export function actionItems(data, conversations = []) {
  const items = [];
  const name = (p) => p.customerName ?? p.sourceMessage?.customerName ?? 'Unknown sender';
  for (const p of data.unassigned) items.push({ id: `u${p.id}`, customer: name(p), order: null, amount: p.amount, reason: 'Customer or order could not be matched', actions: [['review', 'Review details', p]] });
  for (const r of data.rows) {
    if (['cancelled'].includes(r.orderStatus)) continue;
    for (const p of r.payments) {
      if (p.status !== 'pending' || p.kind === 'refund' || p.method === 'cod') continue;
      const review = p.displayStatus === 'pending_review';
      items.push({ id: `p${p.id}`, customer: r.customerName, order: r.item, orderId: r.orderId, amount: p.amount, reason: review ? (p.match?.reason && p.match.state !== 'matched' ? p.match.reason : 'Details need checking') : 'Awaiting verification',
        actions: [...(p.proof ? [] : [['proof', 'Add payment proof', p]]), ['review', 'Review details', p], ['verify', 'Verify', p], ['reject', 'Reject', p]] });
    }
    if (r.payments.length === 0 && r.status === 'due' && (r.balance ?? 0) > 0) items.push({ id: `n${r.orderId}`, customer: r.customerName, order: r.item, orderId: r.orderId, amount: null, reason: 'No payment proof received', actions: [['proof', 'Add payment proof', { orderId: r.orderId }]] });
  }
  for (const c of conversations) for (const m of c.messages) {
    if (m.attachment && m.scan?.state === 'failed') items.push({ id: `f${m.id}`, customer: c.customerName, order: null, orderId: c.orderId, amount: null, reason: 'Screenshot could not be extracted', actions: [['proof', 'Enter details', { orderId: c.orderId }]] });
  }
  return items;
}

export function ActionList({ items, onAct }) {
  if (!items.length) return null;
  return (
    <section className="pm-actions" aria-label="Needs your action">
      <header><h2>Needs action</h2><b>{items.length}</b></header>
      <ul>{items.map((it) => (
        <li key={it.id}>
          <span className="pm-act-who"><b>{it.customer}</b>{it.order && <small>{it.order}</small>}</span>
          <span className="pm-act-amt">{it.amount == null ? '' : formatMoney(it.amount)}</span>
          <span className="pm-act-why">{it.reason}</span>
          <span className="pm-act-btns">{it.actions.map(([kind, label, p]) => <button key={kind} type="button" className={kind === 'verify' ? 'btn btn-sm btn-primary' : 'btn btn-sm'} onClick={() => onAct(kind, p, it)}>{label}</button>)}</span>
        </li>))}</ul>
    </section>
  );
}

// ---- Verify payment: the one compact view behind the single Verify button --------------------------------------------------
// Shows what was claimed and the screenshot large; nothing is recorded until Confirm or Reject is submitted in the form below.
export function VerifyPayment({ payment: p, row, onClose, onChanged, onProof, onDetails }) {
  const [act, setAct] = useState(null); // null | 'confirm' | 'reject'
  const src = proofSrc(p.proof);
  const done = () => { onChanged(); onClose(); };
  return (
    <PaymentModal title={`Verify payment from ${row.customerName}`} onClose={onClose}>
      <div className="pm-verify">
        <header className="pm-mhead">
          <div><h3>{row.customerName}</h3><p>{row.item}{row.orderId ? ` · Order ${shortId(row.orderId)}` : ''}</p></div>
        </header>
        {src ? <button type="button" className="pm-verify-proof" onClick={() => onProof(src)} aria-label="Open the screenshot full size"><img src={src} alt="Payment screenshot sent by the customer" /></button>
          : <p className="pm-note">No screenshot was attached to this payment.</p>}
        <dl className="pm-verify-facts">
          <div><dt>Claimed amount</dt><dd>{formatMoney(p.amount)}</dd></div>
          <div><dt>Method</dt><dd>{METHOD[p.method] ?? p.method}</dd></div>
          <div><dt>Transaction ID</dt><dd>{p.transactionId ?? '—'}</dd></div>
          <div><dt>Payment date</dt><dd>{p.paidAt ? when(p.paidAt) : '—'}</dd></div>
          <div><dt>Status</dt><dd>{p.status === 'confirmed' ? 'Verified' : p.status === 'rejected' ? 'Rejected' : 'Awaiting verification'}</dd></div>
        </dl>
        {!act && (
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setAct('reject')}>Reject payment</button>
            <button type="button" className="btn btn-primary" onClick={() => setAct('confirm')}>Confirm payment</button>
          </div>
        )}
        {!act && onDetails && <p className="pm-fine"><button type="button" className="pm-link" onClick={onDetails}>All payments on this order</button></p>}
        {act === 'confirm' && <ConfirmPanel payment={p} row={row} onProof={onProof} onCancel={() => setAct(null)} onDone={done} />}
        {act === 'reject' && <RejectPanel payment={p} onCancel={() => setAct(null)} onDone={done} />}
      </div>
    </PaymentModal>
  );
}
