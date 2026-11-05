import { useEffect, useRef, useState } from 'react';
import { Check, Pencil, RotateCcw, Sparkles } from 'lucide-react';
import { getOrderSummary, getReplySuggestions, sendConversationMessage } from '../services/api.js';
import { Modal } from './UI.jsx';
import '../css/Replies.css';

const lastCustomer = (c) => [...(c?.messages ?? [])].reverse().find((m) => m.from === 'customer' && m.text) ?? null;

// ---- One-tap smart replies ----------------------------------------------------------------------------------------------------
// Suggestions are only drafted. Pressing a chip is the owner's explicit send; the pencil loads it into the message box to edit first.
export function SmartReplies({ conv, onSent, onEdit }) {
  const [state, setState] = useState({ status: 'idle', items: [], source: null, orderId: null, candidates: [], error: null });
  const [pick, setPick] = useState(null); // an order chosen by the owner when the customer has several
  const [sending, setSending] = useState({}); // id -> 'sending' | 'sent' | 'failed'
  const [note, setNote] = useState(null);
  const trigger = lastCustomer(conv)?.id ?? null;
  const lastIsCustomer = conv.messages.at(-1)?.from === 'customer';
  const ask = useRef(0);

  async function load(orderId = pick) {
    const mine = ++ask.current;
    setState((s) => ({ ...s, status: 'loading', error: null })); setNote(null);
    try {
      const r = await getReplySuggestions(conv.id, orderId);
      if (mine === ask.current) { setSending({}); setState({ status: 'ready', items: r.suggestions, source: r.source, orderId: r.orderId, candidates: r.candidates ?? [], error: null }); }
    } catch (e) { if (mine === ask.current) setState((s) => ({ ...s, status: 'error', error: e.message })); }
  }
  useEffect(() => { setPick(null); setSending({}); setNote(null); if (trigger && lastIsCustomer) load(null); else setState({ status: 'idle', items: [], source: null, orderId: null, candidates: [], error: null }); }, [conv.id, trigger, lastIsCustomer]); // eslint-disable-line react-hooks/exhaustive-deps

  async function send(s) {
    if (sending[s.id] === 'sending') return;
    setSending((x) => ({ ...x, [s.id]: 'sending' })); setNote(null);
    try { await sendConversationMessage(conv.id, s.text); setSending((x) => ({ ...x, [s.id]: 'sent' })); onSent(); }
    catch (e) { setSending((x) => ({ ...x, [s.id]: 'failed' })); setNote(`Not sent: ${e.message}`); }
  }

  if (state.status === 'idle') return (conv.messages.length > 0 ? <div className="rp"><button type="button" className="rp-link" onClick={() => load()}><Sparkles size={13} aria-hidden="true" /> Suggest replies</button></div> : null);
  const needsChoice = state.candidates.length > 1 && !state.orderId;
  return (
    <div className="rp" aria-label="Suggested replies">
      <div className="rp-head">
        <div className="rp-heading"><span className="rp-title">Suggested replies</span><small>Based on this chat and the order</small></div>
        <button type="button" className="rp-icon" onClick={() => load()} disabled={state.status === 'loading'} aria-label="Refresh suggestions" title="Refresh"><RotateCcw size={13} aria-hidden="true" /></button>
      </div>
      {state.candidates.length > 1 && (
        <label className="rp-pick">About
          <select value={pick ?? state.orderId ?? ''} onChange={(e) => { setPick(e.target.value || null); load(e.target.value || null); }}>
            {!state.orderId && <option value="">Choose an order…</option>}
            {state.candidates.map((o) => <option key={o.id} value={o.id}>{o.item} · {o.shortId}</option>)}
          </select>
        </label>
      )}
      {state.status === 'loading' && <p className="rp-state" role="status"><span className="rp-spin" aria-hidden="true" /> Thinking of replies…</p>}
      {state.status === 'error' && <p className="rp-state is-error" role="alert">Couldn’t get suggestions. {state.error} <button type="button" className="rp-link" onClick={() => load()}>Try again</button></p>}
      {state.status === 'ready' && (
        <ul className="rp-chips">
          {state.items.map((s) => {
            const st = sending[s.id];
            return (
              <li key={s.id} className={`rp-chip${st ? ` is-${st}` : ''}`}>
                <button type="button" className="rp-send" onClick={() => send(s)} disabled={st === 'sending' || st === 'sent'} title="Send this reply now">
                  <span>{s.text}</span>
                  {st && <em>{st === 'sending' ? 'Sending…' : st === 'sent' ? <><Check size={12} aria-hidden="true" /> Sent</> : 'Failed · tap to retry'}</em>}
                </button>
                {st !== 'sent' && <button type="button" className="rp-edit" onClick={() => onEdit(s.text)} aria-label="Edit before sending" title="Edit before sending"><Pencil size={14} aria-hidden="true" /></button>}
              </li>
            );
          })}
        </ul>
      )}
      {needsChoice && state.status === 'ready' && <p className="rp-state">This customer has more than one open order. Choose which one the replies are about.</p>}
      {note && <p className="rp-state is-error" role="alert">{note}</p>}
    </div>
  );
}

// ---- Send order summary -------------------------------------------------------------------------------------------------------
// Drafts the summary from the real order and payment records, shows it for editing, and sends only when the owner presses Send.
export function OrderSummaryModal({ conv, simulated, onClose, onSent }) {
  const [orderId, setOrderId] = useState(null);
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [status, setStatus] = useState('loading'); // loading | ready | sending | sent | error
  const [error, setError] = useState(null);

  async function load(id) {
    setStatus('loading'); setError(null);
    try { const r = await getOrderSummary(conv.id, id); setData(r); setText(r.summary?.text ?? ''); setStatus('ready'); }
    catch (e) { setError(e.message); setStatus('error'); }
  }
  useEffect(() => { load(null); }, [conv.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const busy = useRef(false); // set at once, so a fast double click can never send twice
  async function send() {
    if (busy.current) return;
    busy.current = true; setStatus('sending'); setError(null);
    try { await sendConversationMessage(conv.id, text); onSent(); onClose(); }
    catch (e) { setError(e.message); setStatus('ready'); busy.current = false; }
  }
  const choose = data && !data.summary && data.reason === 'choose';
  return (
    <Modal title="Send order summary" onClose={onClose}>
      <div className="rp-sum">
        {status === 'loading' && <p className="rp-state" role="status"><span className="rp-spin" aria-hidden="true" /> Preparing the summary from the order…</p>}
        {status === 'error' && !data && <p className="rp-state is-error" role="alert">Couldn’t prepare the summary. {error} <button type="button" className="rp-link" onClick={() => load(orderId)}>Try again</button></p>}
        {data && data.candidates.length > 1 && (
          <label className="rp-pick">Order
            <select value={orderId ?? data.summary?.orderId ?? ''} onChange={(e) => { setOrderId(e.target.value || null); load(e.target.value || null); }} disabled={status === 'loading' || status === 'sending'}>
              {!data.summary && <option value="">Choose an order…</option>}
              {data.candidates.map((o) => <option key={o.id} value={o.id}>{o.item} · {o.shortId}</option>)}
            </select>
          </label>
        )}
        {data && !data.summary && !choose && status !== 'loading' && <p className="rp-state">No order is linked to this chat yet. Link or extract an order first, then send its summary.</p>}
        {choose && status !== 'loading' && <p className="rp-state">This customer has more than one open order. Choose the one to summarise.</p>}
        {data?.summary && status !== 'loading' && (
          <>
            <p className="rp-lede">Preview — you can edit anything before it is sent. Fields that aren’t on the order are left out.</p>
            <textarea className="rp-text" rows={Math.min(18, text.split('\n').length + 1)} value={text} onChange={(e) => setText(e.target.value)} disabled={status === 'sending'} aria-label="Order summary message" />
            <p className={`rp-mode${simulated ? ' is-sim' : ''}`}>{simulated ? 'Demo: this send is simulated. It is added to the chat and nothing reaches the customer.' : `Sends to ${conv.customerName} on ${conv.channel === 'instagram' ? 'Instagram' : 'WhatsApp'}.`}</p>
            {error && <p className="rp-state is-error" role="alert">Not sent: {error}</p>}
            <div className="form-actions">
              <button type="button" className="btn" onClick={onClose} disabled={status === 'sending'}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={send} disabled={status === 'sending' || !text.trim()}>{status === 'sending' ? 'Sending…' : error ? 'Retry send' : 'Send summary'}</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
