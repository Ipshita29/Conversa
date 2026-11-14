import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import { getPayments } from '../services/api.js';
import useAsync from '../hooks/useAsync.js';
import useLive from '../hooks/useLive.js';
import { formatMoney } from '../utils/format.js';
import { StateMessage } from '../components/UI.jsx';
import { PaymentModal, AssignPayment, METHOD, PaymentDetail, ProofThumb, ProofViewer, RecordPayment, VerifyPayment, detectedFrom } from '../components/Payments.jsx';
import '../css/Payments.css';

const shortId = (id) => `#${/^[a-f\d]{24}$/i.test(String(id)) ? String(id).slice(-6).toUpperCase() : String(id).replace(/^ord_/, '')}`;
const TABS = [['all', 'All'], ['verify', 'To verify'], ['verified', 'Verified']];
// What the owner is told about an order's money. One row per ORDER: the payments inside it (an advance by UPI and the balance on delivery, say) are
// the parts of one story, not separate rows.
const STATE = { paid: ['Paid', 'is-paid'], partial: ['Partly paid', 'is-partial'], verification_pending: ['Awaiting verification', 'is-pending'], cod: ['Cash on delivery', 'is-cod'], due: ['Due', 'is-due'] };
const live = (r) => r.payments.filter((p) => p.kind !== 'refund' && p.status !== 'rejected');
const toVerifyOf = (r) => r.payments.find((p) => p.status === 'pending' && p.kind !== 'refund' && p.method !== 'cod') ?? null; // the claim waiting for the owner (cash on delivery is confirmed when collected)

export default function Payments() {
  const [params, setParams] = useSearchParams();
  const { status, data, error, reload } = useAsync(() => getPayments(), []);
  useLive(['payments', 'orders', 'messages'], reload);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('all');
  const [verifyId, setVerifyId] = useState(null); // the payment being verified
  const [openId, setOpenId] = useState(null);     // the order whose drawer is open
  const [recording, setRecording] = useState(null); // null | { orderId }
  const [proof, setProof] = useState(null);
  const [notice, setNotice] = useState(null);
  const [assigning, setAssigning] = useState(null); // a detected payment that has no order yet
  const [openAct, setOpenAct] = useState(null);    // { id, kind }: open the detail dialog straight into Verify or Reject
  const pendingPay = useRef(null);

  // /payments?record=<orderId> (from Messages) opens the record dialog for that order; ?order=<id> opens its drawer.
  useEffect(() => {
    const r = params.get('record'); const o = params.get('order'); const pay = params.get('payment'); const act = params.get('act');
    if (r !== null) setRecording({ orderId: r || null });
    if (o) setOpenId(o);
    if (pay) pendingPay.current = { id: pay, act: ['confirm', 'reject'].includes(act) ? act : null }; // opened once the ledger has loaded
    if (r !== null || o || pay) setParams({}, { replace: true });
  }, [params, setParams]);
  useEffect(() => { // /payments?payment=<id> (from Messages): open the order the payment is on, or the order picker if it has none yet
    if (!data || !pendingPay.current) return;
    const { id, act } = pendingPay.current;
    const p = detectedFrom(data).find((x) => x.id === id) ?? data.rows.flatMap((r) => r.payments).find((x) => x.id === id);
    pendingPay.current = null;
    if (p) openDetected(p, act);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = data?.rows ?? [];
  const list = useMemo(() => {
    const out = rows.map((r) => ({ key: r.orderId, row: r, pending: toVerifyOf(r), shot: (toVerifyOf(r) ?? r.payments.find((p) => p.proof) ?? {}).proof ?? null }));
    for (const p of data ? detectedFrom(data) : []) out.push({ key: p.id, unmatched: p, row: { customerName: p.customerName, orderId: null, payments: [p] }, shot: p.proof ?? null }); // a screenshot that could not be matched to an order: flagged, never attached to a guess
    return out;
  }, [rows, data]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return list.filter((i) => (tab === 'all' || (tab === 'verify' ? Boolean(i.pending || i.unmatched) : i.row.paid > 0))
      && (!t || `${i.row.customerName} ${i.row.item ?? ''} ${i.row.orderId ?? ''} ${i.row.payments.map((p) => p.transactionId ?? '').join(' ')}`.toLowerCase().includes(t)));
  }, [list, q, tab]);
  const verifying = (() => { if (!verifyId) return null; const r = rows.find((x) => x.payments.some((p) => p.id === verifyId)); const p = r?.payments.find((x) => x.id === verifyId); return p ? { p, row: r } : null; })();
  const selected = rows.find((r) => r.orderId === openId) ?? null;
  const refresh = () => reload();
  const openDetected = (p, act = null) => {
    if (!p.orderId) { setAssigning(p); return; }
    if (p.status === 'pending' && p.method !== 'cod' && p.kind !== 'refund') { setVerifyId(p.id); return; } // a claim to check: straight to the screenshot and Verify / Reject
    setOpenAct(act ? { id: p.id, kind: act } : null); setOpenId(p.orderId);
  };
  // Clicking a row opens what needs deciding: the claim to verify, the unmatched screenshot, or the order's payments.
  const openRow = (i) => { if (i.unmatched) setAssigning(i.unmatched); else if (i.pending) setVerifyId(i.pending.id); else setOpenId(i.row.orderId); };

  const k = data?.kpis;
  return (
    <section className="page payments">
      <header className="pmx-head">
        <div><h1>Payments</h1><p>Keep track of what your customers have paid.</p></div>
        <div className="pmx-head-actions">
          
          <button type="button" className="btn btn-primary pmx-add" onClick={() => setRecording({ orderId: null })} disabled={!data}><Plus size={16} aria-hidden="true" /> Record payment</button>
        </div>
      </header>

      {status === 'loading' && !data && <StateMessage kind="loading" message="Loading payments…" />}
      {status === 'error' && <StateMessage kind="error" message={`Couldn't load payments. ${error.message}`} onRetry={reload} />}
      {notice && <div className="notice ok pm-notice" role="status">{notice} <button type="button" onClick={() => setNotice(null)}>Dismiss</button></div>}

      {data && (
        <>
          <dl className="pmx-overview" aria-label="Payment overview">
            <div><dt>Total received</dt><dd>{formatMoney(k.totalReceived)}</dd><small>Confirmed by you</small></div>
            <div className={k.toVerify ? 'is-amber' : ''}><dt>Awaiting verification</dt><dd>{formatMoney(k.toVerifyAmount)}</dd><small>{k.toVerify ? `${k.toVerify} ${k.toVerify === 1 ? 'payment' : 'payments'} to check` : 'Nothing waiting'}</small></div>
            <div><dt>Outstanding balance</dt><dd>{formatMoney(k.outstanding)}</dd><small>{k.outstandingOrders} {k.outstandingOrders === 1 ? 'order' : 'orders'}{k.codDue > 0 ? ` · ${formatMoney(k.codDue)} on delivery` : ''}</small></div>
          </dl>

          <div className="pmx-bar" role="search">
            <div className="pmx-tabs" role="tablist" aria-label="Show">
              {TABS.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'is-on' : ''} onClick={() => setTab(key)}>{label}</button>)}
            </div>
            <label className="pmx-search"><Search size={15} aria-hidden="true" /><span className="sr-only">Search payments</span><input type="search" placeholder="Search customer, order or reference" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          </div>

          {rows.length === 0 ? <StateMessage message="No orders yet, so there are no payments to show." />
            : shown.length === 0 ? <StateMessage message={tab === 'all' && !q ? 'No payments yet.' : 'No payments match.'} /> : (
              <ul className="pmx-list" aria-label="Payments">
                {shown.map((i) => {
                  const r = i.row; const money = live(r);
                  const methods = [...new Set(money.map((p) => METHOD[p.method] ?? p.method))];
                  const [label, tone] = i.unmatched ? ['Needs review', 'is-pending'] : (i.pending ? STATE.verification_pending : STATE[r.status] ?? [r.status, '']);
                  const parts = i.unmatched ? [`${formatMoney(i.unmatched.amount)} claimed`] : [r.paid > 0 && `${formatMoney(r.paid)} received`, r.pending > 0 && `${formatMoney(r.pending)} awaiting verification`, r.codDue > 0 && `${formatMoney(r.codDue)} on delivery`].filter(Boolean);
                  return (
                    <li key={i.key} className="pmx-row">
                      <button type="button" className="pmx-main" onClick={() => openRow(i)} aria-label={`${r.customerName}${r.orderId ? `, order ${shortId(r.orderId)}` : ''}`}>
                        <span className="pmx-who"><b>{r.customerName}</b><small>{r.orderId ? <>{shortId(r.orderId)} · {r.item}{r.quantity > 1 && !new RegExp(`\\b${r.quantity}\\b`).test(r.item) ? ` × ${r.quantity}` : ''}</> : 'Not matched to an order yet'}</small></span>
                        <span className="pmx-money"><b>{i.unmatched ? formatMoney(i.unmatched.amount) : r.total === null ? '—' : formatMoney(r.total)}</b><small>{parts.join(' · ') || (r.total === null ? 'Not priced' : 'Nothing paid yet')}</small></span>
                        <span className="pmx-method">{methods.length ? methods.join(' · ') : '—'}</span>
                        <span className={`pmx-status ${tone}`}>{label}</span>
                      </button>
                      <span className="pmx-side">
                        {i.shot ? <ProofThumb proof={i.shot} onOpen={setProof} /> : <span className="pmx-noshot" title="No screenshot">—</span>}
                        {(i.pending || i.unmatched) ? <button type="button" className="btn btn-primary btn-sm" onClick={() => openRow(i)}>{i.unmatched ? 'Match' : 'Verify'}</button> : <span className="pmx-spacer" />}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          <p className="pm-foot">Verifying records what you checked in your own bank or UPI account; Conversa never contacts a bank.</p>
        </>
      )}

      {selected && (
        <PaymentModal title={`Payment details for ${selected.customerName}`} onClose={() => { setOpenId(null); setOpenAct(null); }} refreshing={status === 'loading'}>
          <PaymentDetail row={selected} initialAct={openAct} refreshing={status === 'loading'} onChanged={refresh} onRecord={(orderId) => { setOpenId(null); setRecording({ orderId }); }} onProof={setProof} />
        </PaymentModal>
      )}
      {recording && data && <RecordPayment rows={rows} orderId={recording.orderId} onClose={() => setRecording(null)} onSaved={(rec) => { const o = rec?.orderId ?? recording.orderId; setRecording(null);
        setNotice(rec?.reconciled === 'already_recorded' ? 'This transaction was already recorded, so no new payment was added.' : rec?.reconciled ? 'This transaction was already recorded. The existing payment was updated with your screenshot instead of adding a second one.'
          : 'Payment saved. Anything not marked as received is waiting for your verification.'); refresh(); if (o) setOpenId(o); }} />}
      {assigning && data && <AssignPayment payment={assigning} rows={rows} onClose={() => setAssigning(null)} onSaved={(o) => { setAssigning(null); setNotice(o ? 'Payment assigned. It is still waiting for your verification.' : 'Payment rejected.'); refresh(); if (o) setOpenId(o); }} />}
      {verifying && <VerifyPayment payment={verifying.p} row={verifying.row} onDetails={() => { setVerifyId(null); setOpenId(verifying.row.orderId); }} onClose={() => setVerifyId(null)} onChanged={() => { setNotice('Payment updated.'); refresh(); }} onProof={setProof} />}
      {proof && <ProofViewer src={proof} onClose={() => setProof(null)} />}
    </section>
  );
}
