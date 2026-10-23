import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Camera, Copy, ExternalLink, MessageCircle, MessageSquare, Paperclip, Plus, Search, SendHorizontal, Sparkles, Check } from 'lucide-react';
import { getConversations, getIntegrations, listOrders, updateConversation, DEMO_MODE } from '../services/api.js';
import useAsync from '../hooks/useAsync.js';
import { CHANNEL_LABEL, STATUS_LABEL } from '../utils/format.js';
import StateMessage from '../components/StateMessage.jsx';
import Drawer from '../components/Drawer.jsx';
import DraftOrder from '../components/DraftOrder.jsx';
import { StatusBadge } from '../components/Badge.jsx';
import '../css/Inbox.css';

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
  const conv = useAsync(getConversations);
  const integrations = useAsync(getIntegrations);
  const ordersQ = useAsync(() => listOrders({ pageSize: 100 }));
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [selId, setSelId] = useState(null);
  const [chatOpen, setChatOpen] = useState(false); // phones: list or chat, one at a time
  const [drafting, setDrafting] = useState(false);
  const [createdFor, setCreatedFor] = useState(null);
  const [paste, setPaste] = useState(false);
  const [markError, setMarkError] = useState(null);
  const scrollRef = useRef(null);
  const stick = useRef(true); // true while the reader is at (or near) the bottom, so new messages may scroll into view

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

  useEffect(() => { setDrafting(false); }, [selected?.id]);

  // Opening a conversation jumps to its latest message. Afterwards, only follow new messages if the reader is already at the bottom.
  useLayoutEffect(() => { const el = scrollRef.current; if (el) { el.scrollTop = el.scrollHeight; stick.current = true; } }, [selected?.id]);
  useLayoutEffect(() => { const el = scrollRef.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [selected?.messages.length, drafting, createdFor]);
  const onScroll = () => { const el = scrollRef.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; };

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
  const sendNote = !selected ? '' : channelInfo?.status === 'connected'
    ? `Sending replies from Conversa isn't available yet. Reply to ${selected.customerName} in ${CHANNEL_LABEL[selected.channel]} directly.`
    : `${CHANNEL_LABEL[selected.channel]} ${channelInfo?.status === 'demo' ? 'is demo only' : "isn't connected"}, so replies can't be sent from here.`;

  return (
    <section className="page inbox-page">
      <div className={`im${chatOpen ? ' is-chat' : ''}`}>
        

        <aside className="im-side" aria-label="Conversations">
          <header className="im-side-head">
            <h1>Chats</h1>
            <button type="button" className="im-icon-btn" onClick={() => setPaste(true)} aria-label="New message: paste a customer message to draft an order" title="Paste a customer message"><Plus size={18} aria-hidden="true" /></button>
          </header>
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
            <ul className="im-list">
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
                <div className="im-chat-id"><h2>{selected.customerName}</h2><p>{CHANNEL_LABEL[selected.channel]}{selected.isDemo && <span className="im-demo"> · Demo conversation</span>}</p></div>
                <div className="im-chat-actions">
                  {linked ? <Link className="btn btn-sm" to={`/orders?edit=${linked.id}`}><ExternalLink size={14} aria-hidden="true" /> Open order</Link>
                    : !selected.orderId && <button type="button" className="btn btn-sm btn-primary" onClick={() => setDrafting(true)} disabled={drafting}><Sparkles size={14} aria-hidden="true" /> Extract order</button>}
                </div>
              </header>

              <div className="im-scroll" ref={scrollRef} onScroll={onScroll} tabIndex={0} aria-label="Messages">
                {markError && <div className="notice error" role="alert">Couldn't mark this conversation as read: {markError}</div>}
                {groups.map((g) => (
                  <div key={g.key} className="im-day">
                    <p className="im-day-sep"><span>{dayLabel(g.at)}</span></p>
                    {g.items.map((m) => {
                      const mine = m.from && m.from !== 'customer';
                      return (
                        <div key={m.id} className={`im-msg ${mine ? 'is-mine' : 'is-theirs'}`}>
                          <div className="im-bubble"><p>{m.text}</p><span className="im-time"><time dateTime={m.at}>{timeOf(m.at)}</time></span></div>
                          <CopyButton text={m.text ?? ''} />
                        </div>
                      );
                    })}
                  </div>
                ))}

                {createdFor?.convId === selected.id && <div className="notice ok" role="status">Order created for {createdFor.customerName} and linked to this chat.</div>}
                {linked && (
                  <div className="im-linked"><div><p className="eyebrow">Linked order</p><strong>{linked.item}</strong> <StatusBadge status={linked.status} /></div><Link className="btn btn-sm" to={`/orders?edit=${linked.id}`}>Open order</Link></div>
                )}
                {!linked && selected.orderId && <p className="muted im-note">This chat is linked to an order that could not be loaded.</p>}
                {!selected.orderId && drafting && (
                  <div className="im-draft"><h3>Draft an order from this chat</h3>
                    <DraftOrder key={selected.id} autoStart message={last.text} source={selected.channel} customerName={selected.customerName} conversationId={selected.id}
                      onCancel={() => setDrafting(false)}
                      onCreated={(o) => { setDrafting(false); setCreatedFor({ convId: selected.id, customerName: o.customerName }); conv.reload(); ordersQ.reload(); }} /></div>
                )}
                {!selected.orderId && !drafting && <p className="im-hint">The AI can read the latest message and draft an order. You review and confirm it before anything is saved.</p>}
              </div>

              <footer className="im-composer">
                <p className="im-composer-note" role="status"><i className="im-led is-off" />{sendNote}</p>
                <div className="im-composer-row">
                  <button type="button" className="im-icon-btn" disabled aria-label="Attach a file (not available)" title="Attachments aren't supported yet"><Paperclip size={18} aria-hidden="true" /></button>
                  <textarea rows={1} placeholder="Type a message…" disabled aria-label="Message" />
                  <button type="button" className="im-send" disabled aria-label="Send (not available)"><SendHorizontal size={18} aria-hidden="true" /></button>
                </div>
              </footer>
            </>
          )}
        </section>
      </div>

      {paste && (
        <Drawer title="Draft an order from a message" onClose={() => setPaste(false)}>
          <p className="muted drawer-lede">Paste a customer message. The AI drafts an order; you review it before anything is saved.</p>
          <DraftOrder editable onCreated={() => { ordersQ.reload(); }} />
        </Drawer>
      )}
    </section>
  );
}
