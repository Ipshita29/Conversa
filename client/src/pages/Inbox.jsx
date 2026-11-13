import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Camera, Copy, ExternalLink, MessageCircle, MessageSquare, Paperclip, Plus, Search, SendHorizontal, Sparkles, Check, FileText } from 'lucide-react';
import { attachmentSrc, extractMessagePayment, extractPaymentText, getConversations, getIntegrations, getPayments, listOrders, sendConversationMessage, updateConversation, DEMO_MODE } from '../services/api.js';
import useAsync from '../hooks/useAsync.js';
import { CHANNEL_LABEL, STATUS_LABEL } from '../utils/format.js';
import { Drawer, Modal, StateMessage } from '../components/UI.jsx';
import { REC_STATUS, recStatus } from '../components/Payments.jsx';
import { DraftOrder } from '../components/Orders.jsx';
import { parsePaymentText } from '../../../server/services/paymentExtraction.js';
import { formatMoney } from '../utils/format.js';
import useStickyScroll from '../hooks/useStickyScroll.js';
import { OrderSummaryModal, SmartReplies } from '../components/Replies.jsx';
import useDataset from '../hooks/useDataset.js';
import DatasetToggle from '../components/DatasetToggle.jsx';
import '../css/Workspace.css';

const FILTERS = [['all', 'All'], ['unread', 'Unread'], ['whatsapp', 'WhatsApp'], ['instagram', 'Instagram']];
const CHANNEL_ICON = { whatsapp: MessageCircle, instagram: Camera };
const initials = (name) => (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
const hue = (name) => [...(name ?? '')].reduce((h, c) => (h + c.charCodeAt(0)) % 4, 0); // decorative only: picks one of four palette tints
const dayKey = (iso) => new Date(iso).toDateString();
const timeOf = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
function dayLabel(iso) {
  const d = new Date(iso); const now = new Date();
  const diff = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
  return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
function listTime(iso) {
  const d = new Date(iso); const now = new Date();
  if (d.toDateString() === now.toDateString()) return timeOf(iso);
  const diff = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
  return diff === 1 ? 'Yesterday' : diff < 7 ? d.toLocaleDateString(undefined, { weekday: 'short' }) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
const lastOf = (c) => c.messages[c.messages.length - 1];

function Avatar({ name, channel, size = 'md' }) {
  const Icon = CHANNEL_ICON[channel];
  return (
    <span className={`im-avatar im-avatar-${size} im-hue-${hue(name)}`} aria-hidden="true">
      {initials(name)}
      {Icon && size === 'md' && <i className={`im-chan im-chan-${channel}`}><Icon size={10} /></i>}
    </span>
  );
}

function CopyButton({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="im-msg-act" aria-label="Copy message" title="Copy message" onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1400); } catch { /* clipboard unavailable */ } }}>
      {done ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
    </button>
  );
}

export default function Inbox() {
  const ds = useDataset();
  const conv = useAsync(() => (ds.ready ? getConversations(ds.dataset) : new Promise(() => {})), [ds.dataset, ds.ready]);
  const integrations = useAsync(getIntegrations);
  const ordersQ = useAsync(() => (ds.ready ? listOrders({ pageSize: 100, dataset: ds.dataset }) : new Promise(() => {})), [ds.dataset, ds.ready]);
  const paymentsQ = useAsync(() => (ds.ready ? getPayments(ds.dataset) : new Promise(() => {})), [ds.dataset, ds.ready]); // the linked order's payment status, shown in the chat
  const [viewer, setViewer] = useState(null); // a picture opened full size
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [params] = useSearchParams();
  const [selId, setSelId] = useState(params.get('conversation'));
  const [chatOpen, setChatOpen] = useState(Boolean(params.get('conversation'))); // phones: list or chat, one at a time
  const [drafting, setDrafting] = useState(false);
  const [createdFor, setCreatedFor] = useState(null);
  const [paste, setPaste] = useState(false);
  const [markError, setMarkError] = useState(null);
  const [payNote, setPayNote] = useState(null); // result of reading a message or screenshot as a payment: { convId, ok, text }
  const [payBusy, setPayBusy] = useState(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [sendState, setSendState] = useState({ status: 'idle', error: null }); // the message box: idle | sending | failed
  const boxRef = useRef(null);
  const scrollRef = useRef(null);
  const flowRef = useRef(null); // wraps the messages: its size changes when pictures load or messages arrive

  const orders = ordersQ.data?.items ?? [];
  const convs = useMemo(() => [...(conv.data?.items ?? [])].sort((a, b) => new Date(lastOf(b)?.at ?? 0) - new Date(lastOf(a)?.at ?? 0)), [conv.data]);
  const unreadTotal = convs.reduce((s, c) => s + (c.unread ?? 0), 0);
  const q = query.trim().toLowerCase();
  const shown = convs.filter((c) => (filter === 'all' ? true : filter === 'unread' ? c.unread > 0 : c.channel === filter)
    && (!q || c.customerName?.toLowerCase().includes(q) || c.messages.some((m) => m.text?.toLowerCase().includes(q))));
  const selected = convs.find((c) => c.id === (selId ?? convs[0]?.id)) ?? null; // newest by default (not marked read until opened)
  const orderOf = (id) => orders.find((o) => o.id === id);
  const linked = selected?.orderId ? orderOf(selected.orderId) : null;
  const channelInfo = (integrations.data?.items ?? []).find((i) => i.channel === selected?.channel);

  useEffect(() => { setDrafting(false); setPayNote(null); setDraft(''); setSendState({ status: 'idle', error: null }); setSummaryOpen(false); }, [selected?.id]);

  // Typed messages are sent only by the owner's own press of Send (or Enter). Real when the channel is connected, otherwise a clearly marked simulation.
  const simulated = !selected || selected.isDemo || (channelInfo?.state ?? channelInfo?.status) !== 'connected';
  // Meta only allows a free-form reply for 24 hours after the customer's last message (a WhatsApp template is needed after that).
  const windowClosed = !simulated && selected?.lastInboundAt && Date.now() - new Date(selected.lastInboundAt).getTime() > 24 * 3600000;
  async function sendDraft() {
    const text = draft.trim(); if (!text || sendState.status === 'sending') return;
    setSendState({ status: 'sending', error: null });
    try { await sendConversationMessage(selected.id, text); setDraft(''); setSendState({ status: 'idle', error: null }); conv.reload(); }
    catch (e) { setSendState({ status: 'failed', error: e.message }); }
  }

  // Pictures are checked for a payment in the background. While any is still being read, look again every few seconds.
  const scanning = convs.some((c) => c.messages.some((m) => m.scan?.state === 'processing'));
  useEffect(() => {
    if (!scanning) return undefined;
    const t = setInterval(() => { conv.reload(); paymentsQ.reload(); }, 3000);
    return () => clearInterval(t);
  }, [scanning]); // eslint-disable-line react-hooks/exhaustive-deps

  // A customer's payment message or screenshot is filed as "Verification pending" on the linked order. It is a claim, never proof.
  async function readAsPayment(m) {
    setPayBusy(m.id); setPayNote(null);
    try {
      const r = await extractPaymentText({ message: m.text, orderId: selected.orderId, conversationId: selected.id, messageId: m.id });
      setPayNote(r.payment ? { convId: selected.id, ok: true, text: `Added to Payments as Verification pending: ${formatMoney(r.payment.amount)}. It is not counted as received until you confirm it.`, orderId: selected.orderId }
        : { convId: selected.id, ok: false, text: r.reason, orderId: selected.orderId, fallback: true });
    } catch (e) { setPayNote({ convId: selected.id, ok: false, text: e.message, orderId: selected.orderId, fallback: e.status !== 409 }); } finally { setPayBusy(null); }
  }
  // Read a picture in the chat (server-side Groq vision) and file it as Verification pending on the chat's order. Asking twice returns the same record.
  async function readPicture(m) {
    setPayBusy(m.id); setPayNote(null);
    try {
      const r = await extractMessagePayment(selected.id, m);
      conv.reload(); paymentsQ.reload();
      setPayNote({ convId: selected.id, ok: true, text: r.existing ? 'This screenshot was already read. Its payment is below.' : `Read from the screenshot: ${formatMoney(r.payment.amount)}${r.payment.transactionId ? `, reference ${r.payment.transactionId}` : ''}. Filed as Awaiting Verification. It is not counted as received until you confirm it.`, orderId: selected.orderId });
    } catch (er) { setPayNote({ convId: selected.id, ok: false, text: er.message, orderId: selected.orderId, fallback: er.status !== 409 }); } finally { setPayBusy(null); }
  }

  // Opening a conversation jumps to its latest message. Afterwards, only follow new messages if the reader is already at the bottom.
  useStickyScroll(scrollRef, flowRef, selected?.id ?? null);

  async function open(c) {
    setSelId(c.id); setChatOpen(true); setMarkError(null);
    if (c.unread > 0) {
      try { await updateConversation(c.id, { read: true }); conv.reload(); } catch (e) { setMarkError(e.message); }
    }
  }

  if (conv.status === 'loading' && !conv.data) return <section className="page inbox-page"><div className="im"><div className="im-state"><StateMessage kind="loading" message="Loading conversations…" /></div></div></section>;
  if (conv.status === 'error') return <section className="page inbox-page"><div className="im"><div className="im-state"><StateMessage kind="error" message={`Couldn't load conversations. ${conv.error.message}`} onRetry={conv.reload} /></div></div></section>;

  const items = integrations.data?.items ?? [];
  const groups = [];
  selected?.messages.forEach((m) => { const k = dayKey(m.at); const g = groups[groups.length - 1]; if (g?.key === k) g.items.push(m); else groups.push({ key: k, at: m.at, items: [m] }); });
  const last = selected ? lastOf(selected) : null;
  const sendNote = !selected ? '' : simulated
    ? `Demo mode: sends are simulated. Messages appear here and nothing reaches ${selected.customerName} on ${CHANNEL_LABEL[selected.channel]}.`
    : `Messages are sent to ${selected.customerName} through ${CHANNEL_LABEL[selected.channel]}.`;

  return (
    <section className="page inbox-page">
      <div className={`im${chatOpen ? ' is-chat' : ''}`}>
        

        <aside className="im-side" aria-label="Conversations">
          <header className="im-side-head">
            <h1>Chats</h1>
            <button type="button" className="im-icon-btn" onClick={() => setPaste(true)} aria-label="New message: paste a customer message to draft an order" title="Paste a customer message"><Plus size={18} aria-hidden="true" /></button>
          </header>
          {ds.both && <div className="im-ds"><DatasetToggle ds={ds} /></div>}
          <label className="im-search"><Search size={16} aria-hidden="true" /><span className="sr-only">Search conversations</span>
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats and messages" /></label>
          <div className="im-tabs" role="group" aria-label="Filter conversations">
            {FILTERS.map(([key, label]) => <button key={key} type="button" className={`im-tab${filter === key ? ' is-on' : ''}`} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}{key === 'unread' && unreadTotal > 0 && <b>{unreadTotal}</b>}</button>)}
          </div>

          {convs.length === 0 ? (
            <div className="im-empty"><MessageSquare size={30} aria-hidden="true" /><h2>No conversations yet</h2><p>{DEMO_MODE ? 'Sample conversations appear here.' : 'They appear here once WhatsApp or Instagram is connected and a customer writes in.'} You can still paste a message to draft an order.</p><button type="button" className="btn btn-sm" onClick={() => setPaste(true)}>Paste a message</button></div>
          ) : shown.length === 0 ? (
            <div className="im-empty"><Search size={28} aria-hidden="true" /><h2>{q ? 'No chats found' : 'Nothing here'}</h2><p>{q ? `Nothing matches “${query.trim()}”.` : `No ${FILTERS.find(([k]) => k === filter)?.[1].toLowerCase()} conversations.`}</p>{(q || filter !== 'all') && <button type="button" className="btn btn-sm" onClick={() => { setQuery(''); setFilter('all'); }}>Clear search and filters</button>}</div>
          ) : (
            <ul className="im-list" data-lenis-prevent>
              {shown.map((c) => {
                const m = lastOf(c); const o = orderOf(c.orderId); const sel = selected?.id === c.id;
                return (
                  <li key={c.id}>
                    <button type="button" className={`im-row${sel ? ' is-selected' : ''}${c.unread > 0 ? ' is-unread' : ''}`} aria-current={sel ? 'true' : undefined} onClick={() => open(c)}>
                      <Avatar name={c.customerName} channel={c.channel} />
                      <span className="im-row-main">
                        <span className="im-row-top"><strong>{c.customerName}</strong><time dateTime={m?.at}>{m ? listTime(m.at) : ''}</time></span>
                        <span className="im-row-bottom"><span className="im-preview">{m?.from && m.from !== 'customer' ? 'You: ' : ''}{m?.text}</span>{c.unread > 0 && <b className="im-unread" aria-label={`${c.unread} unread`}>{c.unread}</b>}</span>
                        {c.orderId && <span className="im-row-order">{o ? `${o.item} · ${STATUS_LABEL[o.status]}` : 'Order linked'}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <footer className="im-conn" aria-label="Channel connections">
            {integrations.status === 'error' ? <span className="im-conn-item" title="Couldn't check integrations"><i className="im-led is-off" />Connections unknown <button type="button" className="im-link" onClick={integrations.reload}>Retry</button></span>
              : items.length === 0 ? <span className="im-conn-item">Checking connections…</span>
                : items.map((i) => <span key={i.channel} className="im-conn-item" title={i.statusReason}><i className={`im-led is-${i.status}`} />{CHANNEL_LABEL[i.channel]} {i.status === 'connected' ? 'connected' : i.status === 'demo' ? 'demo only' : 'not connected'}</span>)}
          </footer>
        </aside>

        <section className="im-chat" aria-label={selected ? `Conversation with ${selected.customerName}` : 'Conversation'}>
          {!selected ? (
            <div className="im-chat-empty"><MessageSquare size={40} aria-hidden="true" /><h2>Select a conversation</h2><p>Pick a chat on the left to read it, then turn it into an order you review before anything is saved.</p></div>
          ) : (
            <>
              <header className="im-chat-head">
                <button type="button" className="im-icon-btn im-back" onClick={() => setChatOpen(false)} aria-label="Back to chats"><ArrowLeft size={18} aria-hidden="true" /></button>
                <Avatar name={selected.customerName} channel={selected.channel} size="lg" />
                <div className="im-chat-id"><h2>{selected.customerName}</h2><p>{CHANNEL_LABEL[selected.channel]}{selected.isDemo && <span className="im-demo">Demo conversation</span>}</p></div>
                <div className="im-chat-actions">
                  {linked ? <Link className="btn btn-sm" to={`/orders?edit=${linked.id}`}><ExternalLink size={14} aria-hidden="true" /> Open order</Link>
                    : !selected.orderId && <button type="button" className="btn btn-sm btn-primary" onClick={() => setDrafting(true)} disabled={drafting}><Sparkles size={14} aria-hidden="true" /> Extract order</button>}
                  {selected && <>
                    <button type="button" className="btn btn-sm" onClick={() => setSummaryOpen(true)} title="Draft the order's details as a message you can edit and send"><FileText size={14} aria-hidden="true" /> Send order summary</button>
                  </>}
                </div>
              </header>

              <div className="im-scroll" ref={scrollRef} data-lenis-prevent tabIndex={0} aria-label="Messages"><div className="im-flow" ref={flowRef}>
                {selected.isDemo && <div className="notice info im-demo-note" role="note"><b>Demo conversation.</b> These are sample messages and pictures to show how Conversa organises an order. They are not live WhatsApp or Instagram messages.</div>}
                {markError && <div className="notice error" role="alert">Couldn't mark this conversation as read: {markError}</div>}
                {groups.map((g) => (
                  <div key={g.key} className="im-day">
                    <p className="im-day-sep"><span>{dayLabel(g.at)}</span></p>
                    {g.items.map((m) => {
                      const mine = m.from && m.from !== 'customer';
                      return (
                        <div key={m.id} className={`im-msg ${mine ? 'is-mine' : 'is-theirs'}`}>
                          <div className="im-bubble">{m.attachment && <button type="button" className="im-img" onClick={() => setViewer({ src: attachmentSrc(m.attachment), m })} aria-label="View the picture full size"><img src={attachmentSrc(m.attachment)} alt="Picture sent in this chat" loading="lazy" /></button>}{m.text && <p>{m.text}</p>}<span className="im-time"><time dateTime={m.at}>{timeOf(m.at)}</time></span>
                            {m.attachment && (m.payment
                              ? <span className={`im-pay${recStatus(m.payment) === 'pending_review' ? ' is-review' : ''}`} role="status">
                                  <b>{m.scan?.state ? 'Payment detected' : 'Payment'} {formatMoney(m.payment.amount)} · {REC_STATUS[recStatus(m.payment)]}</b>
                                  {recStatus(m.payment) === 'pending_review' && <small><AlertTriangle size={11} aria-hidden="true" /> {m.scan?.reason ?? 'Needs a look before it is used.'}</small>}
                                  <Link className="im-link" to={`/payments?payment=${m.payment.id}`}>{recStatus(m.payment) === 'pending_review' ? 'Review in Payments' : 'Open in Payments'}</Link></span>
                              : m.scan?.state === 'processing' ? <span className="im-pay" role="status"><b><span className="im-spin" aria-hidden="true" /> Checking for a payment…</b></span>
                              : m.scan?.state === 'failed' ? <span className="im-pay is-failed" role="alert"><b>Couldn’t read this screenshot</b><small>{m.scan.reason}</small>
                                  <button type="button" className="im-link" onClick={() => readPicture(m)} disabled={payBusy === m.id}>{payBusy === m.id ? 'Trying…' : 'Try again'}</button>
                                  <Link className="im-link" to={`/payments?record=${selected.orderId ?? ''}`}>Record it by hand</Link></span>
                              : m.scan?.state === 'duplicate' ? <span className="im-pay"><b>Already recorded</b><small>{m.scan.reason}</small></span>
                              : m.scan?.state === 'not_payment' ? <span className="im-pay"><b>Reference image</b>{selected.orderId ? <small>Shown in the order’s details</small> : <small>Link an order to keep it with the order</small>}</span>
                              : <span className="im-pay"><b>May be a payment proof</b>{selected.orderId ? <button type="button" className="im-link" onClick={() => readPicture(m)} disabled={payBusy === m.id}>{payBusy === m.id ? 'Reading…' : 'Extract payment details'}</button> : <small>Link an order to read it</small>}</span>)}
                            {!mine && m.text && !m.attachment && (() => { const x = parsePaymentText(m.text); return x.isPayment ? (
                              <span className="im-pay"><b>Looks like a payment{x.amount ? ` · ${formatMoney(x.amount)}` : ''}</b>
                                {selected.orderId ? <button type="button" className="im-link" onClick={() => readAsPayment(m)} disabled={payBusy === m.id}>{payBusy === m.id ? 'Reading…' : 'Read as payment'}</button> : <small>Link an order to file it</small>}</span>) : null; })()}
                          </div>
                          {m.text && <CopyButton text={m.text} />}
                          {mine && m.delivery && <small className={`im-sent${m.delivery.mode === 'simulated' ? ' is-sim' : m.delivery.state === 'failed' ? ' is-fail' : ''}`}>{m.delivery.mode === 'simulated' ? 'Simulated · not sent to the customer' : m.delivery.state === 'failed' ? `Not delivered${m.delivery.error ? ` · ${m.delivery.error}` : ''}` : m.delivery.state === 'read' ? 'Read' : m.delivery.state === 'delivered' ? 'Delivered' : 'Sent'}</small>}
                        </div>
                      );
                    })}
                  </div>
                ))}

                {payNote?.convId === selected.id && (
                  <div className={`notice ${payNote.ok ? 'ok' : 'info'}`} role="status">{payNote.text}{' '}
                    {payNote.ok ? (!payNote.plain && <Link to={`/payments?order=${payNote.orderId}`}>Review in Payments</Link>) : payNote.fallback && <Link to={`/payments?record=${payNote.orderId}`}>Record it by hand</Link>}</div>
                )}
                {createdFor?.convId === selected.id && <div className="notice ok" role="status">Order created for {createdFor.customerName} and linked to this chat.</div>}
                {!selected.orderId && drafting && (
                  <div className="im-draft"><h3>Draft an order from this chat</h3>
                    <DraftOrder key={selected.id} autoStart message={last.text} source={selected.channel} customerName={selected.customerName} conversationId={selected.id}
                      onCancel={() => setDrafting(false)}
                      onCreated={(o) => { setDrafting(false); setCreatedFor({ convId: selected.id, customerName: o.customerName }); conv.reload(); ordersQ.reload(); }} /></div>
                )}
                {!selected.orderId && !drafting && <p className="im-hint">The AI can read the latest message and draft an order. You review and confirm it before anything is saved.</p>}
                </div>
              </div>

              <SmartReplies conv={selected} onSent={() => conv.reload()} onEdit={(t) => { setDraft(t); setTimeout(() => boxRef.current?.focus(), 0); }} />
              <footer className="im-composer">
                {windowClosed && <p className="rp-state is-error" role="alert">{selected.customerName} last wrote more than 24 hours ago. {selected.channel === 'whatsapp' ? 'WhatsApp only allows a free-form reply within 24 hours of their last message; after that an approved message template is required.' : 'Instagram only allows a reply within 24 hours of their last message.'} You can reply once they write again.</p>}
                <p className="im-composer-note" role="status"><i className={`im-led ${simulated ? 'is-off' : 'is-connected'}`} />{sendNote}</p>
                {sendState.status === 'failed' && <p className="rp-state is-error" role="alert">Not sent: {sendState.error}</p>}
                <div className="im-composer-row">
                  <button type="button" className="im-icon-btn" disabled aria-label="Attach a file (not available)" title="Attachments aren't supported yet"><Paperclip size={18} aria-hidden="true" /></button>
                  <textarea ref={boxRef} rows={1} placeholder="Type a message..." aria-label="Message" value={draft} onChange={(e) => { setDraft(e.target.value); if (sendState.status === 'failed') setSendState({ status: 'idle', error: null }); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendDraft(); } }} disabled={sendState.status === 'sending'} />
                  <button type="button" className="im-send" onClick={sendDraft} disabled={!draft.trim() || sendState.status === 'sending' || Boolean(windowClosed)} aria-label={sendState.status === 'sending' ? 'Sending' : 'Send message'}><SendHorizontal size={18} aria-hidden="true" /></button>
                </div>
              </footer>
            </>
          )}
        </section>
      </div>

      {summaryOpen && selected && <OrderSummaryModal conv={selected} simulated={simulated} onClose={() => setSummaryOpen(false)} onSent={() => conv.reload()} />}

      {viewer && (
        <Modal variant="lightbox" title={viewer.m.payment || ['filed', 'review', 'duplicate'].includes(viewer.m.scan?.state) ? 'Payment screenshot' : 'Reference picture'} onClose={() => setViewer(null)}>
          <div className="pm-proof-big"><img src={viewer.src} alt="Picture sent in this chat" /></div>
          {viewer.m.payment ? <p className="pm-fine">A screenshot does not prove the money reached your account. <Link to={`/payments?payment=${viewer.m.payment.id}`}>Open the payment</Link></p>
            : selected?.orderId && <p className="pm-fine">Kept with the order. <Link to={`/orders?edit=${selected.orderId}`}>Open the order</Link></p>}
        </Modal>)}

      {paste && (
        <Drawer title="Draft an order from a message" onClose={() => setPaste(false)}>
          <p className="muted drawer-lede">Paste a customer message. The AI drafts an order; you review it before anything is saved.</p>
          <DraftOrder editable onCreated={() => { ordersQ.reload(); }} />
        </Drawer>
      )}
    </section>
  );
}
