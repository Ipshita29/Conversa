import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import { getPayments } from '../services/api.js';
import useAsync from '../hooks/useAsync.js';
import { formatMoney } from '../utils/format.js';
import { DemoBadge, StateMessage } from '../components/UI.jsx';
import { PaymentModal, AssignPayment, Kpis, METHOD, PaymentDetail, ProofViewer, RecordPayment, VerifyPayment, detectedFrom, recStatus } from '../components/Payments.jsx';
import '../css/Payments.css';

const shortId = (id) => `#${/^[a-f\d]{24}$/i.test(String(id)) ? String(id).slice(-6).toUpperCase() : String(id).replace(/^ord_/, '')}`;
const TABS = [['all', 'All'], ['verify', 'To verify'], ['verified', 'Verified']];
// One list item per payment record (plus an order with no payment yet), each with the single state its action column shows.
const kindOf = (p) => (p.kind === 'refund' ? 'refund' : p.method === 'cod' && p.status === 'pending' ? 'cod' : { verified: 'verified', rejected: 'rejected' }[recStatus(p)] ?? 'verify');
const KIND = { verified: 'Verified', rejected: 'Rejected', refund: 'Refunded', cod: 'COD', due: 'Due' };

export default function Payments() {
  const [params, setParams] = useSearchParams();
  const { status, data, error, reload } = useAsync(getPayments);
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
    const out = rows.flatMap((r) => (r.payments.length === 0
      ? [{ key: `due-${r.orderId}`, row: r, p: null, kind: 'due', amount: r.total }]
      : r.payments.map((p) => ({ key: p.id, row: r, p, kind: kindOf(p), amount: p.amount }))));
    for (const p of data ? detectedFrom(data) : []) out.push({ key: p.id, row: { customerName: p.customerName, item: p.item, orderId: null }, p, kind: kindOf(p), amount: p.amount });
    return out;
  }, [rows, data]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return list.filter((i) => (tab === 'all' || (tab === 'verify' ? i.kind === 'verify' : i.kind === 'verified'))
      && (!t || `${i.row.customerName} ${i.row.item ?? ''} ${i.row.orderId ?? ''} ${i.p?.transactionId ?? ''}`.toLowerCase().includes(t)));
  }, [list, q, tab]);
  const verifying = (() => { if (!verifyId) return null; const i = list.find((x) => x.p?.id === verifyId); return i ? { p: i.p, row: i.row } : null; })();
  const selected = rows.find((r) => r.orderId === openId) ?? null;
  const refresh = () => reload();
  const openDetected = (p, act = null) => { if (!p.orderId) { setAssigning(p); return; } setOpenAct(act ? { id: p.id, kind: act } : null); setOpenId(p.orderId); };
  const verify = (i) => { if (i.row.orderId) setVerifyId(i.p.id); else setAssigning(i.p); };

  return (
    <section className="page payments">
      <header className="pm-head">
        <div>
          <h1>Payments</h1>
        </div>
        <div className="pm-head-actions">
          <DemoBadge />
          <button type="button" className="btn btn-primary pm-add" onClick={() => setRecording({ orderId: null })} disabled={!data}><Plus size={16} aria-hidden="true" /> Record payment</button>
        </div>
      </header>

      {status === 'loading' && !data && <StateMessage kind="loading" message="Loading payments…" />}
      {status === 'error' && <StateMessage kind="error" message={`Couldn't load payments. ${error.message}`} onRetry={reload} />}
      {notice && <div className="notice ok pm-notice" role="status">{notice} <button type="button" onClick={() => setNotice(null)}>Dismiss</button></div>}

      {data && (
        <>
          <Kpis kpis={data.kpis} />
          <div className="pm-bar" role="search">
            <div className="pm-tabs" role="tablist" aria-label="Show">
              {TABS.map(([k, v]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-on' : ''} onClick={() => setTab(k)}>{v}</button>)}
            </div>
            <label className="pm-search"><Search size={15} aria-hidden="true" /><span className="sr-only">Search payments</span><input type="search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          </div>

          {rows.length === 0 ? <StateMessage message="No orders yet, so there are no payments to show." />
            : shown.length === 0 ? <StateMessage message="No payments match." /> : (
              <div className="pm-list" role="table" aria-label="Payments">
                <div className="pm-li pm-li-head" role="row">
                  <span role="columnheader">Customer &amp; order</span><span role="columnheader" className="r">Amount</span><span role="columnheader">Method</span><span role="columnheader">Status</span><span role="columnheader" className="r">Action</span>
                </div>
                {shown.map((i) => (
                  <div key={i.key} role="row" className="pm-li">
                    <span role="cell" className="pm-who">
                      {i.row.orderId ? <button type="button" className="pm-name" onClick={() => setOpenId(i.row.orderId)}>{i.row.customerName}</button> : <b>{i.row.customerName}</b>}
                      <small>{i.row.item ?? 'Not matched to an order'}{i.row.orderId ? ` · ${shortId(i.row.orderId)}` : ''}</small>
                    </span>
                    <span role="cell" className="r pm-amt" data-l="Amount">{i.amount === null || i.amount === undefined ? '—' : formatMoney(i.amount)}</span>
                    <span role="cell" data-l="Method">{i.p ? METHOD[i.p.method] ?? i.p.method : '—'}</span>
                    <span role="cell" className={`pm-st is-${i.kind}`} data-l="Status">{i.kind === 'verify' ? 'Awaiting verification' : KIND[i.kind]}</span>
                    <span role="cell" className="r">{i.kind === 'verify' && <button type="button" className="btn btn-primary btn-sm" onClick={() => verify(i)}>Verify</button>}</span>
                  </div>
                ))}
              </div>
            )}
          <p className="pm-foot">Verifying records what you checked in your own bank or UPI account; Conversa never contacts a bank.</p>
        </>
      )}

      {selected && (
        <PaymentModal title={`Payment details for ${selected.customerName}`} onClose={() => { setOpenId(null); setOpenAct(null); }} refreshing={status === 'loading'}>
          <PaymentDetail row={selected} initialAct={openAct} refreshing={status === 'loading'} onChanged={refresh} onRecord={(orderId) => { setOpenId(null); setRecording({ orderId }); }} onProof={setProof} />
        </PaymentModal>
      )}
      {recording && data && <RecordPayment rows={rows} orderId={recording.orderId} onClose={() => setRecording(null)} onSaved={() => { const o = recording.orderId; setRecording(null); setNotice('Payment saved. Anything not marked as received is waiting for your verification.'); refresh(); if (o) setOpenId(o); }} />}
      {assigning && data && <AssignPayment payment={assigning} rows={rows} onClose={() => setAssigning(null)} onSaved={(o) => { setAssigning(null); setNotice(o ? 'Payment assigned. It is still waiting for your verification.' : 'Payment rejected.'); refresh(); if (o) setOpenId(o); }} />}
      {verifying && <VerifyPayment payment={verifying.p} row={verifying.row} onClose={() => setVerifyId(null)} onChanged={() => { setNotice('Payment updated.'); refresh(); }} onProof={setProof} />}
      {proof && <ProofViewer src={proof} onClose={() => setProof(null)} />}
    </section>
  );
}
