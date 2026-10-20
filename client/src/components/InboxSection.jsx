import { useEffect, useMemo, useState } from 'react';
import { ClipboardPaste, Link as LinkIcon } from 'lucide-react';
import { getConversations, updateConversation, DEMO_MODE } from '../services/api.js';
import useAsync from '../hooks/useAsync.js';
import { formatDateTime, relativeTime } from '../utils/format.js';
import SectionHead from './SectionHead.jsx';
import '../css/Inbox.css';
import StateMessage from './StateMessage.jsx';
import Drawer from './Drawer.jsx';
import DraftOrder from './DraftOrder.jsx';
import { ChannelBadge, StatusBadge } from './Badge.jsx';

const FILTERS = [['all', 'All'], ['unread', 'Unread'], ['whatsapp', 'WhatsApp'], ['instagram', 'Instagram']];

export default function InboxSection({ orders, onChanged, onSettled }) {
  const { status, data, error, reload } = useAsync(getConversations);
  useEffect(() => { if (status !== 'loading') onSettled?.(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  const [filter, setFilter] = useState('all');
  const [open, setOpen] = useState(null); // { convId } | { paste: true }
  const [createdFor, setCreatedFor] = useState(null); // { convId, customerName } shown after an order is created from a message

  const rows = useMemo(() => (data?.items ?? [])
    .flatMap((c) => c.messages.map((m) => ({ ...m, conv: c })))
    .sort((a, b) => new Date(b.at) - new Date(a.at)), [data]);
  const unread = rows.filter((r) => !r.read).length;
  const shown = rows.filter((r) => (filter === 'all' ? true : filter === 'unread' ? !r.read : r.conv.channel === filter));
  const orderOf = (id) => orders.find((o) => o.id === id);
  const selected = open?.convId ? data?.items.find((c) => c.id === open.convId) : null;

  // Opening a conversation marks its messages read (a real PATCH), then the counts refresh.
  useEffect(() => {
    if (!selected || selected.unread === 0) return;
    updateConversation(selected.id, { read: true }).then(reload).catch(() => {});
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <SectionHead eyebrow="Inbox" title="Every conversation, in one place.">Customer messages from across your channels, gathered into one clear inbox.</SectionHead>

      {status === 'loading' && !data && <StateMessage kind="loading" message="Loading conversations…" />}
      {status === 'error' && <StateMessage kind="error" message={`Couldn't load conversations. ${error.message}`} onRetry={reload} />}

      {data && (
        <>
          <div className="inbox-bar">
            <p className="inbox-count" aria-live="polite"><b>{rows.length}</b> messages · <b>{rows.length - unread}</b> read · <b>{unread}</b> unread</p>
            <div className="chips" role="group" aria-label="Filter messages">
              {FILTERS.map(([key, label]) => (
                <button key={key} type="button" className={`chip${filter === key ? ' is-on' : ''}`} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>
              ))}
            </div>
            <button type="button" className="btn btn-sm" onClick={() => setOpen({ paste: true })}><ClipboardPaste size={14} aria-hidden="true" /> Paste a message</button>
          </div>

          {rows.length === 0 ? (
            <StateMessage message={DEMO_MODE ? 'No conversations yet.' : 'No conversations yet. Messages appear here once WhatsApp or Instagram is connected and a customer writes in. You can still paste a message to draft an order.'} />
          ) : shown.length === 0 ? (
            <StateMessage message="No messages match this filter." />
          ) : (
            <ul className="msg-list">
              {shown.map((r) => {
                const order = orderOf(r.conv.orderId);
                return (
                  <li key={r.id}>
                    <button type="button" className={`msg-row${r.read ? '' : ' is-unread'}`} onClick={() => setOpen({ convId: r.conv.id })}>
                      <span className="msg-dot" aria-label={r.read ? 'Read' : 'Unread'} role="img" />
                      <span className="msg-who"><strong>{r.conv.customerName}</strong><ChannelBadge channel={r.conv.channel} /></span>
                      <span className="msg-preview">{r.text}</span>
                      <span className="msg-meta">
                        <time dateTime={r.at} title={formatDateTime(r.at)}>{relativeTime(r.at)}</time>
                        {r.conv.orderId
                          ? <span className="msg-order"><LinkIcon size={12} aria-hidden="true" />{order ? <>{order.item} · <StatusBadge status={order.status} /></> : 'Order linked'}</span>
                          : <span className="msg-order muted">No order yet</span>}
                        {r.conv.isDemo && <span className="demo-tag">Demo</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {open?.paste && (
        <Drawer title="Draft an order from a message" onClose={() => setOpen(null)}>
          <p className="muted drawer-lede">Paste a customer message. The AI drafts an order; you review it before anything is saved.</p>
          <DraftOrder editable onCreated={onChanged} />
        </Drawer>
      )}
      {selected && (
        <Drawer title={selected.customerName} onClose={() => { setOpen(null); setCreatedFor(null); }}>
          {createdFor?.convId === selected.id && <div className="notice ok" role="status">Order created for {createdFor.customerName} and linked to this message.</div>}
          <div className="drawer-meta"><ChannelBadge channel={selected.channel} />{selected.isDemo && <span className="demo-tag">Demo</span>}</div>
          {selected.messages.map((m) => (
            <blockquote key={m.id} className="bubble"><p>{m.text}</p><footer>{formatDateTime(m.at)}</footer></blockquote>
          ))}
          {selected.orderId && orderOf(selected.orderId) ? (
            <div className="drawer-order">
              <p className="eyebrow">Related order</p>
              <p><strong>{orderOf(selected.orderId).item}</strong> <StatusBadge status={orderOf(selected.orderId).status} /></p>
            </div>
          ) : (
            <div className="drawer-draft">
              <h3>Turn this into an order</h3>
              <DraftOrder key={selected.id} message={selected.messages[selected.messages.length - 1].text} source={selected.channel} customerName={selected.customerName}
                conversationId={selected.id} onCreated={(o) => { setCreatedFor({ convId: selected.id, customerName: o.customerName }); onChanged?.(); reload(); }} />
            </div>
          )}
        </Drawer>
      )}
    </>
  );
}
