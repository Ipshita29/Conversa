import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import { getPayments } from '../services/api.js';
import useAsync from '../hooks/useAsync.js';
import { formatMoney } from '../utils/format.js';
import { DemoBadge, StateMessage } from '../components/UI.jsx';
import PaymentModal from '../components/PaymentModal.jsx';
import { Kpis, METHOD, PaymentDetail, ProofThumb, ProofViewer, RecordPayment, SOURCE, STATUS, StatusPill } from '../components/Payments.jsx';
import '../css/Payments.css';

const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—');
const shortId = (id) => `#${/^[a-f\d]{24}$/i.test(String(id)) ? String(id).slice(-6).toUpperCase() : String(id).replace(/^ord_/, '')}`;
const VERIFY = [['all', 'Any verification'], ['pending', 'Awaiting verification'], ['confirmed', 'Verified by you'], ['none', 'No payment recorded']];
const EMPTY = { q: '', status: 'all', method: 'all', verify: 'all', from: '', to: '' };

export default function Payments() {
  const [params, setParams] = useSearchParams();
  const { status, data, error, reload } = useAsync(getPayments);
  const [f, setF] = useState(EMPTY);
  const [openId, setOpenId] = useState(null);     // the order whose drawer is open
  const [recording, setRecording] = useState(null); // null | { orderId }
  const [proof, setProof] = useState(null);
  const [notice, setNotice] = useState(null);

  // /payments?record=<orderId> (from Messages) opens the record dialog for that order; ?order=<id> opens its drawer.
  useEffect(() => {
    const r = params.get('record'); const o = params.get('order');
    if (r !== null) setRecording({ orderId: r || null });
    if (o) setOpenId(o);
    if (r !== null || o) setParams({}, { replace: true });
  }, [params, setParams]);

  const rows = data?.rows ?? [];
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const shown = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    const from = f.from ? new Date(`${f.from}T00:00:00`).getTime() : null;
    const to = f.to ? new Date(`${f.to}T23:59:59`).getTime() : null;
    return rows.filter((r) => {
      if (q && !`${r.customerName} ${r.item} ${r.orderId} ${r.payments.map((p) => p.transactionId ?? '').join(' ')}`.toLowerCase().includes(q)) return false;
      if (f.status !== 'all' && r.status !== f.status) return false;
      if (f.method !== 'all' && !r.payments.some((p) => p.method === f.method)) return false;
      if (f.verify === 'pending' && !r.payments.some((p) => p.status === 'pending')) return false;
      if (f.verify === 'confirmed' && !r.payments.some((p) => p.status === 'confirmed')) return false;
      if (f.verify === 'none' && r.payments.length > 0) return false;
      if (from !== null || to !== null) {
        const hit = r.payments.some((p) => { const t = p.paidAt ? Date.parse(p.paidAt) : null; return t !== null && (from === null || t >= from) && (to === null || t <= to); });
        if (!hit) return false;
      }
      return true;
    });
  }, [rows, f]);
  const filtered = JSON.stringify(f) !== JSON.stringify(EMPTY);
  const selected = rows.find((r) => r.orderId === openId) ?? null;
  const refresh = () => reload();

  return (
    <section className="page payments">
      <header className="pm-head">
        <div>
          <h1>Payments</h1>
          <p className="pm-sub">What has been paid, what is owed, and what still needs your check.</p>
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
          <div className="pm-filters" role="search">
            <label className="pm-search"><Search size={16} aria-hidden="true" /><span className="sr-only">Search payments</span><input type="search" placeholder="Search customer, product, order or reference" value={f.q} onChange={set('q')} /></label>
            <label className="pm-sel"><span className="sr-only">Payment status</span><select value={f.status} onChange={set('status')}><option value="all">All statuses</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="pm-sel"><span className="sr-only">Payment method</span><select value={f.method} onChange={set('method')}><option value="all">All methods</option>{Object.entries(METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="pm-sel"><span className="sr-only">Verification</span><select value={f.verify} onChange={set('verify')}>{VERIFY.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="pm-date"><span>From</span><input type="date" value={f.from} max={f.to || undefined} onChange={set('from')} /></label>
            <label className="pm-date"><span>To</span><input type="date" value={f.to} min={f.from || undefined} onChange={set('to')} /></label>
            {filtered && <button type="button" className="pm-link" onClick={() => setF(EMPTY)}>Clear</button>}
          </div>

          {rows.length === 0 ? <StateMessage message="No orders yet, so there are no payments to show." />
            : shown.length === 0 ? <StateMessage message="No payments match these filters."><button type="button" className="btn" onClick={() => setF(EMPTY)}>Clear filters</button></StateMessage> : (
              <div className="pm-ledger" role="table" aria-label="Payment ledger">
                <div className="pm-row pm-row-head" role="row">
                  <span role="columnheader">Customer · order</span><span role="columnheader" className="r">Total</span><span role="columnheader" className="r">Paid</span><span role="columnheader" className="r">Balance</span>
                  <span role="columnheader">Method · reference</span><span role="columnheader">Status</span><span role="columnheader">Paid on</span><span role="columnheader">Proof</span><span role="columnheader">Source</span>
                </div>
                {shown.map((r) => (
                  <div key={r.orderId} role="row" className={`pm-row${r.status === 'verification_pending' ? ' is-verify' : ''}`} tabIndex={0} onClick={() => setOpenId(r.orderId)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(r.orderId); } }} aria-label={`${r.customerName}, ${r.item}, ${STATUS[r.status]}. Open payment details.`}>
                    <span role="cell" className="pm-who"><b>{r.customerName}{r.isDemo && <i className="demo-tag">Demo</i>}</b><small>{r.item} · {shortId(r.orderId)}</small></span>
                    <span role="cell" className="r" data-l="Total">{r.total === null ? '—' : formatMoney(r.total)}</span>
                    <span role="cell" className="r" data-l="Paid">{formatMoney(r.paid)}</span>
                    <span role="cell" className={`r${(r.balance ?? 0) > 0 ? ' is-owed' : ''}`} data-l="Balance">{r.balance === null ? '—' : formatMoney(r.balance)}</span>
                    <span role="cell" className="pm-meth" data-l="Method">{r.method ? METHOD[r.method] : r.codDue > 0 ? 'COD' : '—'}<small>{r.reference ?? (r.codDue > 0 ? 'Due on delivery' : '')}</small></span>
                    <span role="cell"><StatusPill status={r.status} />{r.toVerify > 0 && r.status !== 'verification_pending' && <small className="pm-extra">+{r.toVerify} to verify</small>}</span>
                    <span role="cell" data-l="Paid on">{when(r.paidAt)}</span>
                    <span role="cell"><ProofThumb proof={r.payments.find((p) => p.proof)?.proof} onOpen={setProof} /></span>
                    <span role="cell" className="pm-src" data-l="Source">{r.source ? SOURCE[r.source] : '—'}</span>
                  </div>
                ))}
              </div>
            )}
          <p className="pm-foot">Confirmation is manual: Conversa records what you checked in your own bank or UPI account, and does not contact a bank. Production status is separate and is never changed by a payment.</p>
        </>
      )}

      {selected && (
        <PaymentModal title={`Payment details for ${selected.customerName}`} onClose={() => setOpenId(null)} refreshing={status === 'loading'}>
          <PaymentDetail row={selected} refreshing={status === 'loading'} onChanged={refresh} onRecord={(orderId) => { setOpenId(null); setRecording({ orderId }); }} onProof={setProof} />
        </PaymentModal>
      )}
      {recording && data && <RecordPayment rows={rows} orderId={recording.orderId} onClose={() => setRecording(null)} onSaved={() => { const o = recording.orderId; setRecording(null); setNotice('Payment saved. Anything not marked as received is waiting for your verification.'); refresh(); if (o) setOpenId(o); }} />}
      {proof && <ProofViewer src={proof} onClose={() => setProof(null)} />}
    </section>
  );
}
