import { useState } from 'react';
import { Sparkles, Link as LinkIcon } from 'lucide-react';
import { getConversations, extractOrder, createOrder, DEMO_MODE } from '../services/api.js';
import useAsync from '../hooks/useAsync.js';
import { SOURCES } from '../utils/validateOrder.js';
import { CHANNEL_LABEL, formatDateTime } from '../utils/format.js';
import PageHeader from '../components/PageHeader.jsx';
import StateMessage from '../components/StateMessage.jsx';
import OrderForm from '../components/OrderForm.jsx';
import { ChannelBadge } from '../components/Badge.jsx';
import '../css/Inbox.css';

export default function Inbox() {
  const { status, data, error, reload } = useAsync(getConversations);
  const [selectedId, setSelectedId] = useState(null);
  const [linked, setLinked] = useState({}); // conversationId -> orderId, created this session
  const [message, setMessage] = useState('');
  const [source, setSource] = useState('whatsapp');
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState(null);
  const [extraction, setExtraction] = useState(null); // { result, conversationId }
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [created, setCreated] = useState(null);

  const conversations = data?.items ?? [];
  const selected = conversations.find((c) => c.id === (selectedId ?? conversations[0]?.id));

  async function runExtract(text, channel, conv) {
    setExtracting(true);
    setExtractError(null);
    setExtraction(null);
    setCreated(null);
    setSaveError(null);
    try {
      const result = await extractOrder({ message: text, source: channel, ...(conv && !conv.customerName.startsWith('Unknown') ? { customerName: conv.customerName } : {}) });
      setExtraction({ result, conversationId: conv?.id ?? null });
    } catch (e) {
      setExtractError(e);
    } finally {
      setExtracting(false);
    }
  }

  function extractFromMessage(text) {
    setMessage(text);
    setSource(selected.channel);
    runExtract(text, selected.channel, selected);
  }

  async function confirm(payload) {
    setSaving(true);
    setSaveError(null);
    try {
      const order = await createOrder(payload);
      if (extraction.conversationId) setLinked((l) => ({ ...l, [extraction.conversationId]: order.id }));
      setCreated(order);
      setExtraction(null);
      setMessage('');
    } catch (e) {
      setSaveError(e);
    } finally {
      setSaving(false);
    }
  }

  const uncertain = Object.fromEntries((extraction?.result.uncertainties ?? []).map((u) => [u.field, u.message]));

  return (
    <section className="page inbox">
      <PageHeader title="Inbox" subtitle="Customer conversations from WhatsApp and Instagram." />

      {status === 'loading' && <StateMessage kind="loading" message="Loading conversations…" />}
      {status === 'error' && <StateMessage kind="error" message={`Couldn't load conversations. ${error.message}`} onRetry={reload} />}

      <div className="inbox-layout">
        <aside className="panel conv-list" aria-label="Conversations">
          {status === 'ready' && conversations.length === 0 && <StateMessage message={DEMO_MODE ? 'No conversations yet.' : 'No conversations yet. Messages appear here once WhatsApp or Instagram is connected and a customer writes in.'} />}
          {conversations.map((c) => {
            const last = c.messages[c.messages.length - 1];
            const orderId = linked[c.id] ?? c.orderId;
            return (
              <button type="button" key={c.id} className={`conv${selected?.id === c.id ? ' is-active' : ''}`} onClick={() => setSelectedId(c.id)}>
                <div className="conv-top">
                  <strong>{c.customerName}</strong>
                  {c.unread > 0 && <span className="unread">{c.unread}</span>}
                </div>
                <p className="conv-preview">{last.text}</p>
                <div className="conv-tags">
                  <ChannelBadge channel={c.channel} />
                  {DEMO_MODE && <span className="badge demo-tag">Demo conversation</span>}
                  {orderId && <span className="badge order-tag"><LinkIcon size={11} /> {orderId}</span>}
                </div>
              </button>
            );
          })}
        </aside>

        <div className="inbox-main">
          {selected && (
            <div className="panel">
              <div className="thread-head">
                <div>
                  <h2>{selected.customerName}</h2>
                  <small className="muted">{selected.phone ?? selected.handle}</small>
                </div>
                <ChannelBadge channel={selected.channel} />
              </div>
              <ul className="thread">
                {selected.messages.map((m) => (
                  <li key={m.id} className={`bubble from-${m.from}`}>
                    <p>{m.text}</p>
                    <div className="bubble-meta">
                      <small>{formatDateTime(m.at)}</small>
                      {m.from === 'customer' && (
                        <button type="button" className="btn btn-sm" disabled={extracting} onClick={() => extractFromMessage(m.text)}><Sparkles size={12} /> Extract order</button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="panel">
            <div className="panel-header"><h2>Extract order from a message</h2><p>Paste or type a customer message. Nothing is saved until you confirm.</p></div>
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="e.g. Hi! Can I get 2 dozen cupcakes by Friday evening?" aria-label="Customer message" />
            <div className="compose-actions">
              <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source channel">
                {SOURCES.map((s) => <option key={s} value={s}>{CHANNEL_LABEL[s]}</option>)}
              </select>
              <button type="button" className="btn btn-primary" disabled={extracting || !message.trim()} onClick={() => runExtract(message, source, selected)}>
                <Sparkles size={15} /> {extracting ? 'Extracting…' : 'Extract order details'}
              </button>
            </div>
            <p className="muted compose-note">Replying to customers from Conversa isn't available yet (no messaging endpoint).</p>
          </div>

          {extractError && (
            <div className="notice error" role="alert">
              Couldn't extract order details: {extractError.message} You can create the order manually from the Orders page.
            </div>
          )}
          {created && <div className="notice ok" role="status">Order created for {created.customerName} ({created.id}).</div>}

          {extraction && (
            <div className="panel review">
              <div className="panel-header">
                <h2>Review extracted order <span className="badge draft-tag">Draft — not saved</span></h2>
                <p>
                  {extraction.result.missingFields.length > 0 && `Missing: ${extraction.result.missingFields.join(', ')}. `}
                  {Object.keys(uncertain).length > 0 && 'Check the highlighted uncertain fields. '}
                  {DEMO_MODE && 'Extraction here is simulated with simple keyword rules, not a real AI.'}
                </p>
              </div>
              {saveError && <div className="notice error" role="alert">{saveError.message}</div>}
              <OrderForm initial={extraction.result.draft} missing={extraction.result.missingFields} uncertain={uncertain}
                serverErrors={saveError?.details} submitting={saving} submitLabel="Confirm & create order"
                onSubmit={confirm} onCancel={() => setExtraction(null)} />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
