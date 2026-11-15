import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getPayments, proofSrc } from '../services/api.js';
import useAsync from '../hooks/useAsync.js';
import useLive from '../hooks/useLive.js';
import { formatMoney } from '../utils/format.js';
import { StateMessage } from '../components/UI.jsx';
import { PaymentModal, AssignPayment, METHOD, PaymentDetail, ProofViewer, RecordPayment, VerifyPayment, detectedFrom } from '../components/Payments.jsx';
import { AtelierBackdrop, AtelierBar, AtelierHero, AtelierOverview, ReceiptGallery, VerificationDesk } from '../components/PaymentAtelier.jsx';
import '../css/Payments.css';

const TABS = [['all', 'All'], ['verify', 'To verify'], ['verified', 'Verified']];
// What the owner is told about an order's money. One row per ORDER: the payments inside it (an advance by UPI and the balance on delivery, say) are
// the parts of one story, not separate rows.
const STATE = { paid: ['Verified', 'paid'], partial: ['Partly paid', 'due'], verification_pending: ['Awaiting verification', 'pending'], cod: ['Cash on delivery', 'cod'], due: ['Outstanding', 'due'] };
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

  // One card per entry in the ledger: the same facts the old rows showed, laid out as receipts.
  const cardOf = (i) => {
    const r = i.row; const methods = [...new Set(live(r).map((p) => METHOD[p.method] ?? p.method))];
    const [label, tone] = i.unmatched ? ['Needs review', 'pending'] : (i.pending ? STATE.verification_pending : STATE[r.status] ?? [r.status, 'due']);
    const parts = i.unmatched ? [`${formatMoney(i.unmatched.amount)} claimed`] : [r.paid > 0 && `${formatMoney(r.paid)} received`, r.pending > 0 && `${formatMoney(r.pending)} awaiting verification`, r.codDue > 0 && `${formatMoney(r.codDue)} on delivery`].filter(Boolean);
    const qty = r.quantity > 1 && !new RegExp(`\\b${r.quantity}\\b`).test(r.item) ? ` × ${r.quantity}` : '';
    const pay = i.unmatched ?? i.pending ?? r.payments.find((p) => p.proof) ?? live(r)[0] ?? null;
    return {
      key: i.key, entry: i, name: r.customerName, orderId: r.orderId, product: `${r.item ?? ''}${qty}`, label, tone, pay,
      amount: i.unmatched ? formatMoney(i.unmatched.amount) : r.total === null ? '—' : formatMoney(r.total), detail: parts.join(' · ') || (r.total === null ? 'Not priced' : 'Nothing paid yet'),
      methods: methods.length ? methods.join(' · ') : '—', src: proofSrc(i.shot), actionable: Boolean(i.pending || i.unmatched),
    };
  };
  const cards = useMemo(() => shown.map(cardOf), [shown]); // eslint-disable-line react-hooks/exhaustive-deps
  const deskItems = useMemo(() => list.map(cardOf).filter((c) => c.src && c.pay).map((c) => ({ ...c, tone: c.actionable ? 'pending' : c.pay.status === 'confirmed' ? 'paid' : c.tone })), [list]); // eslint-disable-line react-hooks/exhaustive-deps
  const [deskKey, setDeskKey] = useState(null);
  const deskSel = (deskItems.find((c) => c.key === deskKey) ?? deskItems.find((c) => c.actionable) ?? deskItems[0])?.key ?? null;
  const counts = { all: list.length, verify: list.filter((i) => i.pending || i.unmatched).length, verified: list.filter((i) => i.row.paid > 0).length };
  const confirmedCount = rows.reduce((n, r) => n + r.payments.filter((p) => p.kind === 'payment' && p.status === 'confirmed').length, 0);

  const k = data?.kpis;
  return (
    <section className="page payments pa">
      <AtelierBackdrop />
      {status === 'loading' && !data && <StateMessage kind="loading" message="Loading payments…" />}
      {status === 'error' && <StateMessage kind="error" message={`Couldn't load payments. ${error.message}`} onRetry={reload} />}
      {notice && <div className="notice ok pm-notice" role="status">{notice} <button type="button" onClick={() => setNotice(null)}>Dismiss</button></div>}

      {data && (
        <>
          <AtelierHero k={k} count={rows.length} canRecord onRecord={() => setRecording({ orderId: null })} />
          <AtelierOverview k={k} confirmedCount={confirmedCount} />
          <VerificationDesk items={deskItems} selectedKey={deskSel} onSelect={setDeskKey} onVerify={openRow} onOpen={openRow} onProof={setProof} />

          <section className="pa-activity" aria-labelledby="pa-act-h">
            <div className="pa-sec-head"><h2 id="pa-act-h">Payment activity</h2><p>Every payment as a receipt. Open one to see everything on that order.</p></div>
            <AtelierBar tabs={TABS} tab={tab} setTab={setTab} q={q} setQ={setQ} counts={counts} />
            {rows.length === 0 ? <StateMessage message="No orders yet, so there are no payments to show." />
              : shown.length === 0 ? <StateMessage message={tab === 'all' && !q ? 'No payments yet.' : 'No payments match.'} />
                : <ReceiptGallery cards={cards} onOpen={openRow} onProof={setProof} />}
          </section>
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
