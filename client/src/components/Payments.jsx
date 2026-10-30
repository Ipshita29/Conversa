import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, Paperclip, RotateCcw, ShieldAlert } from 'lucide-react';
import { confirmPayment, proofSrc, readPaymentScreenshot, recordPayment, refundPayment, rejectPayment, uploadPaymentProof } from '../services/api.js';
import { formatMoney, fromLocalInput, toLocalInput } from '../utils/format.js';
import { Modal } from './UI.jsx';
import AmountFigures from './AmountFigures.jsx';
import { useGuard } from './PaymentModal.jsx';
import { validatePaymentInput } from '../../../server/services/paymentLogic.js';

export const STATUS = { paid: 'Paid', partial: 'Partially paid', due: 'Due', cod: 'COD', verification_pending: 'Verification pending' };
export const METHOD = { upi: 'UPI', bank_transfer: 'Bank transfer', cash: 'Cash', cod: 'COD', other: 'Other' };
export const SOURCE = { manual: 'Entered manually', chat_text: 'From a chat message', chat_screenshot: 'From a chat screenshot', screenshot_upload: 'From an uploaded screenshot' };
const REC_STATUS = { pending: 'Verification pending', confirmed: 'Confirmed', rejected: 'Rejected' };
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

export function ProofThumb({ proof, onOpen, size = 'sm' }) {
  const src = proofSrc(proof);
  if (!src) return <span className="pm-noproof">—</span>;
  return <button type="button" className={`pm-thumb is-${size}`} onClick={(e) => { e.stopPropagation(); onOpen(src); }} aria-label="View payment screenshot"><img src={src} alt="" loading="lazy" /></button>;
}

export function ProofViewer({ src, onClose }) {
  return <Modal title="Payment screenshot" onClose={onClose}><div className="pm-proof-big"><img src={src} alt="Payment screenshot sent by the customer" /></div><p className="pm-fine">The original file, exactly as it was received. A screenshot does not prove the money reached your account.</p></Modal>;
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
        <em className={`pm-pill is-rec-${refund ? 'refund' : p.status}`}>{refund ? 'Refunded' : p.method === 'cod' && p.status === 'pending' ? 'COD · due on delivery' : REC_STATUS[p.status]}</em>
      </header>
      <Facts rows={[['Reference', p.transactionId ?? (p.method === 'cod' || p.method === 'cash' ? 'None needed' : '—')], ['Paid', p.paidAt ? when(p.paidAt) : p.method === 'cod' ? 'On delivery' : '—'], ['Source', `${SOURCE[p.source] ?? p.source}${p.isDemo ? ' · demo' : ''}`], p.notes && ['Notes', p.notes]]} />
      {p.proof ? <div className="pm-rec-proof"><ProofThumb proof={p.proof} onOpen={onProof} size="lg" /><span>Original screenshot, kept as received</span></div>
        : !refund && <label className="pm-attach"><Paperclip size={13} aria-hidden="true" /> {adding ? 'Uploading…' : 'Attach screenshot'}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={attach} disabled={adding} /></label>}
      {p.extraction && <Extraction x={p.extraction} />}
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

export function PaymentDetail({ row, tz, onChanged, onRecord, onProof, refreshing = false }) {
  const [act, setAct] = useState(null);
  const [settle, setSettle] = useState(0); // bumped after a rejection so the figures re-settle on the confirmed values
  const guard = useGuard();
  const root = useRef(null);
  // After a confirmation, rejection or refund, return to the amounts so the owner sees them settle.
  const changed = () => { root.current?.closest('.pm-modal-body')?.scrollTo({ top: 0, behavior: 'smooth' }); onChanged(); };
  useEffect(() => { setAct(null); }, [row.orderId]);
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
    try { if (f.received && !x0) saveReviewer(f.reviewer.trim()); await recordPayment(body, file); onSaved(); }
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

