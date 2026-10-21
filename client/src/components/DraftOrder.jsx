import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { extractOrder, createOrder, updateConversation, DEMO_MODE } from '../services/api.js';
import { SOURCES } from '../utils/validateOrder.js';
import { CHANNEL_LABEL } from '../utils/format.js';
import OrderForm from './OrderForm.jsx';

// message -> AI draft -> seller reviews/edits -> explicit confirm -> real order. Nothing is saved before the confirm step.
export default function DraftOrder({ message: initialMessage = '', source: initialSource = 'whatsapp', customerName, conversationId, editable = false, autoStart = false, onCancel, onCreated }) {
  const [message, setMessage] = useState(initialMessage);
  const [source, setSource] = useState(initialSource);
  const [stage, setStage] = useState('idle'); // idle | extracting | review | manual | created
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState(null);

  // autoStart: the seller already pressed "Extract order" elsewhere, so read the message straight away.
  useEffect(() => { if (autoStart && initialMessage.trim()) extract(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function extract() {
    setStage('extracting'); setError(null);
    try {
      const body = { message, source, ...(customerName && !customerName.startsWith('Unknown') ? { customerName } : {}) };
      setDraft(await extractOrder(body));
      setStage('review');
    } catch (e) { setError(e); setStage('idle'); }
  }

  async function confirm(payload) {
    setSaving(true); setSaveError(null);
    try {
      const order = await createOrder(payload);
      let linkWarning = null;
      if (conversationId) { try { await updateConversation(conversationId, { orderId: order.id }); } catch (e) { linkWarning = e.message; } }
      setCreated({ order, linkWarning }); setStage('created');
      onCreated?.(order);
    } catch (e) { setSaveError(e); } finally { setSaving(false); }
  }

  if (stage === 'created') {
    return <div className="notice ok" role="status">Order created for {created.order.customerName}.{created.linkWarning && ` The message could not be linked to it: ${created.linkWarning}`}</div>;
  }

  if (stage === 'review' || stage === 'manual') {
    const uncertain = Object.fromEntries((draft?.uncertainties ?? []).map((u) => [u.field, u.message]));
    return (
      <div className="draft-review">
        {stage === 'review' && (
          <>
            <p className="sim-label">AI draft — not saved yet</p>
            <p className="muted draft-note">
              {draft.missingFields.length > 0 ? `Missing: ${draft.missingFields.join(', ')}. ` : ''}
              {Object.keys(uncertain).length > 0 ? 'Please check the highlighted fields. ' : ''}
              {DEMO_MODE ? 'Demo mode: extraction is simulated with simple keyword rules.' : 'Prep time, when shown, is an estimate from your preparation rules.'}
            </p>
          </>
        )}
        {saveError && <div className="notice error" role="alert">{saveError.message}</div>}
        <OrderForm initial={draft?.draft ?? { customerName, source }} missing={draft?.missingFields ?? []} uncertain={uncertain}
          serverErrors={saveError?.details} submitting={saving} submitLabel="Confirm & create order" onSubmit={confirm} onCancel={() => (onCancel ? onCancel() : setStage('idle'))} />
      </div>
    );
  }

  return (
    <div className="draft-start">
      {editable && (
        <>
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Paste a customer message, e.g. “Can I get 2 dozen cupcakes by Friday evening?”" aria-label="Customer message" />
          <label className="field draft-source"><span className="field-label">Channel</span>
            <select value={source} onChange={(e) => setSource(e.target.value)}>{SOURCES.map((s) => <option key={s} value={s}>{CHANNEL_LABEL[s]}</option>)}</select>
          </label>
        </>
      )}
      {error && (
        <div className="notice error" role="alert">
          Couldn't draft this order: {error.message}
          <div><button type="button" className="btn btn-sm" onClick={() => { setDraft(null); setStage('manual'); }}>Enter the order manually</button></div>
        </div>
      )}
      <div className="form-actions draft-actions">
        {onCancel && <button type="button" className="btn" onClick={onCancel} disabled={stage === 'extracting'}>Cancel</button>}
        <button type="button" className="btn btn-primary" disabled={stage === 'extracting' || !message.trim()} onClick={extract}>
          <Sparkles size={15} aria-hidden="true" />{stage === 'extracting' ? 'Reading the message…' : 'Draft order with AI'}
        </button>
      </div>
    </div>
  );
}
