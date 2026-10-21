import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ClipboardPaste, Link as LinkIcon, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getConversations, getIntegrations, listOrders, updateConversation, DEMO_MODE } from '../services/api.js';
import useAsync from '../hooks/useAsync.js';
import { formatDateTime, relativeTime, CHANNEL_LABEL, STATUS_LABEL } from '../utils/format.js';
import PageHeader from '../components/PageHeader.jsx';
import StateMessage from '../components/StateMessage.jsx';
import Drawer from '../components/Drawer.jsx';
import DraftOrder from '../components/DraftOrder.jsx';
import { ChannelBadge, StatusBadge } from '../components/Badge.jsx';
import '../css/Inbox.css';

const FILTERS = [['all', 'All'], ['unread', 'Unread'], ['whatsapp', 'WhatsApp'], ['instagram', 'Instagram']];

// What each channel integration can honestly do right now, from GET /integrations.
function Channels({ integrations }) {
  const { status, data, reload } = integrations;
  if (status === 'loading' && !data) return <p className="muted ib-channels">Checking integrations…</p>;
  if (status === 'error') return <div className="notice ib-channels" role="status">Couldn't check the WhatsApp and Instagram integrations. <button type="button" className="btn btn-sm" onClick={reload}>Try again</button></div>;
  const items = data.items ?? [];
  const connected = items.filter((i) => i.status === 'connected');
  return (
    <div className="ib-channels">
      <ul className="ib-chips" aria-label="Integration status">
        {items.map((i) => <li key={i.channel} className={`ib-chip ib-${i.status}`}><b>{CHANNEL_LABEL[i.channel]}</b> {i.status === 'connected' ? 'Connected' : i.status === 'demo' ? 'Demo only' : 'Not connected'}</li>)}
      </ul>
      {connected.length === 0 && <p className="muted">{items.filter((i) => i.status !== 'connected').map((i) => `${CHANNEL_LABEL[i.channel]}: ${i.statusReason}`).join(' ')}</p>}
    </div>
  );
}

export default function Inbox() {
  const conv = useAsync(getConversations);
  const integrations = useAsync(getIntegrations);
  const ordersQ = useAsync(() => listOrders({ pageSize: 100 }));
  const [filter, setFilter] = useState('all');
  const [selId, setSelId] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false); // phones: list or detail, one at a time
  const [drafting, setDrafting] = useState(false);
  const [createdFor, setCreatedFor] = useState(null);
  const [paste, setPaste] = useState(false);
  const [markError, setMarkError] = useState(null);
  const panelRef = useRef(null);

  const orders = ordersQ.data?.items ?? [];
  const rows = useMemo(() => (conv.data?.items ?? [])
    .flatMap((c) => c.messages.map((m) => ({ ...m, conv: c })))
    .sort((a, b) => new Date(b.at) - new Date(a.at)), [conv.data]);
  const unread = rows.filter((r) => !r.read).length;
  const shown = rows.filter((r) => (filter === 'all' ? true : filter === 'unread' ? !r.read : r.conv.channel === filter));
  const selected = conv.data?.items.find((c) => c.id === (selId ?? rows[0]?.conv.id)) ?? null; // newest by default (not marked read until you open it)
  const orderOf = (id) => orders.find((o) => o.id === id);

  useEffect(() => { setDrafting(false); }, [selected?.id]);

  async function open(c) {
    setSelId(c.id); setDetailOpen(true); setMarkError(null);
    if (c.unread > 0) {
      try { await updateConversation(c.id, { read: true }); conv.reload(); } catch (e) { setMarkError(e.message); }
    }
    setTimeout(() => panelRef.current?.focus?.({ preventScroll: true }), 50);
  }

  const header = <PageHeader eyebrow="Inbox" title="Every conversation, in one place." subtitle="Read a message, then turn it into an order you review before anything is saved." />;
  if (conv.status === 'loading' && !conv.data) return <section className="page inbox-page">{header}<StateMessage kind="loading" message="Loading conversations…" /></section>;
  if (conv.status === 'error') return <section className="page inbox-page">{header}<StateMessage kind="error" message={`Couldn't load conversations. ${conv.error.message}`} onRetry={conv.reload} /></section>;

  const allDemo = rows.length > 0 && rows.every((r) => r.conv.isDemo);
  const linked = selected?.orderId ? orderOf(selected.orderId) : null;
  const last = selected?.messages[selected.messages.length - 1];

  return (
    <section className="page inbox-page">
      {header}
      <Channels integrations={integrations} />
      {allDemo && <div className="notice info" role="note">These are <b>demo messages</b> stored in your database. They did not come from a connected WhatsApp or Instagram account.</div>}

      <div className={`ib${detailOpen ? ' is-detail' : ''}`}>
        <aside className="ib-list" aria-label="Messages">
          <div className="ib-bar">
            <p className="ib-count" aria-live="polite"><b>{rows.length}</b> messages · <b>{unread}</b> unread</p>
            <button type="button" className="btn btn-sm" onClick={() => setPaste(true)}><ClipboardPaste size={14} aria-hidden="true" /> Paste a message</button>
          </div>
          <div className="chips" role="group" aria-label="Filter messages">
            {FILTERS.map(([key, label]) => <button key={key} type="button" className={`chip${filter === key ? ' is-on' : ''}`} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}
          </div>
          {rows.length === 0 ? (
            <StateMessage message={DEMO_MODE ? 'No conversations yet.' : 'No messages yet. They appear here once WhatsApp or Instagram is connected and a customer writes in. You can still paste a message to draft an order.'} />
          ) : shown.length === 0 ? (
            <StateMessage message="No messages match this filter." />
          ) : (
            <ul className="msg-list">
              {shown.map((r) => {
                const order = orderOf(r.conv.orderId);
                return (
                  <li key={r.id}>
                    <button type="button" className={`msg-row${r.read ? '' : ' is-unread'}${selected?.id === r.conv.id ? ' is-selected' : ''}`} aria-current={selected?.id === r.conv.id ? 'true' : undefined} onClick={() => open(r.conv)}>
                      <span className="msg-dot" role="img" aria-label={r.read ? 'Read' : 'Unread'} />
                      <span className="msg-who"><strong>{r.conv.customerName}</strong><ChannelBadge channel={r.conv.channel} /></span>
                      <span className="msg-preview">{r.text}</span>
                      <span className="msg-meta">
                        <time dateTime={r.at} title={formatDateTime(r.at)}>{relativeTime(r.at)}</time>
                        {r.conv.orderId ? <span className="msg-order"><LinkIcon size={12} aria-hidden="true" />{order ? `${order.item} · ${STATUS_LABEL[order.status]}` : 'Order linked'}</span> : <span className="msg-order muted">No order yet</span>}
                        {r.conv.isDemo && <span className="demo-tag">Demo</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <article className="ib-detail" ref={panelRef} tabIndex={-1} aria-label={selected ? `Conversation with ${selected.customerName}` : 'Message'}>
          {!selected ? (
            <StateMessage message="Select a message to read it." />
          ) : (
            <>
              <button type="button" className="btn btn-sm ib-back" onClick={() => setDetailOpen(false)}><ArrowLeft size={14} aria-hidden="true" /> All messages</button>
              <header className="ib-dhead">
                <div>
                  <h2>{selected.customerName}</h2>
                  <p className="muted"><ChannelBadge channel={selected.channel} />{selected.isDemo && <span className="demo-tag">Demo message</span>}</p>
                </div>
              </header>
              {markError && <div className="notice error" role="alert">Couldn't mark this message as read: {markError}</div>}
              {selected.isDemo && <p className="muted ib-demo-note">Demo message: stored sample data, not from a connected account.</p>}
              {selected.messages.map((m) => (
                <blockquote key={m.id} className="bubble"><p>{m.text}</p><footer>{formatDateTime(m.at)} · {m.read ? 'Read' : 'Unread'}</footer></blockquote>
              ))}

              {createdFor?.convId === selected.id && <div className="notice ok" role="status">Order created for {createdFor.customerName} and linked to this message.</div>}
              {linked ? (
                <div className="ib-order">
                  <p className="eyebrow">Linked order</p>
                  <p><strong>{linked.item}</strong> <StatusBadge status={linked.status} /></p>
                  <Link className="btn btn-sm" to={`/orders?edit=${linked.id}`}>Open order</Link>
                </div>
              ) : selected.orderId ? (
                <p className="muted">This message is linked to an order that could not be loaded.</p>
              ) : drafting ? (
                <div className="ib-draft">
                  <h3>Draft an order from this message</h3>
                  <DraftOrder key={selected.id} autoStart message={last.text} source={selected.channel} customerName={selected.customerName} conversationId={selected.id}
                    onCancel={() => setDrafting(false)}
                    onCreated={(o) => { setCreatedFor({ convId: selected.id, customerName: o.customerName }); conv.reload(); ordersQ.reload(); }} />
                </div>
              ) : (
                <div className="ib-actions">
                  <button type="button" className="btn btn-primary" onClick={() => setDrafting(true)}><Sparkles size={15} aria-hidden="true" /> Extract order</button>
                  <p className="muted">The AI reads the message and drafts an order. You review and confirm it before anything is saved.</p>
                </div>
              )}
            </>
          )}
        </article>
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
