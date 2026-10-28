import { useState, useEffect } from 'react';
import { AlertTriangle, Sparkles } from 'lucide-react';
import { validateOrder, ORDER_STATUSES, PAYMENT_STATUSES, SOURCES } from '../utils/validateOrder.js';
import { STATUS_LABEL, PAYMENT_LABEL, CHANNEL_LABEL, toLocalInput, fromLocalInput } from '../utils/format.js';
import { extractOrder, createOrder, updateConversation, DEMO_MODE } from '../services/api.js';

// ---------- OrderForm ----------
function Field({ label, hint, children, error, isMissing, note }) {
  return (
    <label className={`field${error ? ' has-error' : ''}${isMissing ? ' is-missing' : ''}${note && !error ? ' is-uncertain' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {error && <span className="field-note error" role="alert">{error}</span>}
      {isMissing && <span className="field-note"><AlertTriangle size={12} /> Not found in the message — please fill in.</span>}
      {note && !error && <span className="field-note"><AlertTriangle size={12} /> {note}</span>}
      {hint && !error && !isMissing && !note && <span className="field-hint">{hint}</span>}
    </label>
  );
}

// Used for creating/editing orders and for reviewing an AI draft.
// `missing` highlights fields the AI could not find; `uncertain` maps field -> note to confirm.
export function OrderForm({ initial = {}, missing = [], uncertain = {}, serverErrors = [], submitting, submitLabel = 'Save order', showStatus = false, onSubmit, onCancel }) {
  const [v, setV] = useState({
    customerName: initial.customerName ?? '',
    item: initial.item ?? '',
    quantity: initial.quantity ?? 1,
    source: initial.source ?? 'manual',
    prepTimeMinutes: initial.prepTimeMinutes ?? '',
    price: initial.price ?? '',
    deadline: toLocalInput(initial.deadline),
    status: initial.status ?? 'pending',
    paymentStatus: initial.paymentStatus ?? 'unverified',
  });
  const [clientErrors, setClientErrors] = useState([]);
  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.value }));

  const errorFor = (f) => [...clientErrors, ...serverErrors].find((e) => e.field === f)?.message;

  function submit(e) {
    e.preventDefault();
    const payload = {
      customerName: v.customerName.trim(),
      item: v.item.trim(),
      quantity: v.quantity === '' ? NaN : Number(v.quantity),
      source: v.source,
      prepTimeMinutes: v.prepTimeMinutes === '' ? null : Number(v.prepTimeMinutes),
      price: v.price === '' ? null : Number(v.price),
      deadline: fromLocalInput(v.deadline),
    };
    if (showStatus) { payload.status = v.status; payload.paymentStatus = v.paymentStatus; }
    const errs = validateOrder(payload);
    setClientErrors(errs);
    if (errs.length === 0) onSubmit(payload);
  }

  // Props for the module-level <Field>, so inputs keep focus between renders.
  const fp = (name) => ({ name, error: errorFor(name), isMissing: missing.includes(name) && !errorFor(name), note: uncertain[name] });

  return (
    <form className="order-form" onSubmit={submit} noValidate>
      <div className="form-grid">
        <Field {...fp("customerName")} label="Customer name *"><input value={v.customerName} onChange={set('customerName')} maxLength={120} /></Field>
        <Field {...fp("source")} label="Channel">
          <select value={v.source} onChange={set('source')}>{SOURCES.map((s) => <option key={s} value={s}>{CHANNEL_LABEL[s]}</option>)}</select>
        </Field>
        <Field {...fp("item")} label="Item *"><input value={v.item} onChange={set('item')} maxLength={200} /></Field>
        <Field {...fp("quantity")} label="Quantity"><input type="number" min="0" step="any" value={v.quantity} onChange={set('quantity')} /></Field>
        <Field {...fp("prepTimeMinutes")} label="Preparation time (minutes)" hint="Leave empty if unknown — the order will be left out of capacity planning.">
          <input type="number" min="0" step="1" value={v.prepTimeMinutes} onChange={set('prepTimeMinutes')} />
        </Field>
        <Field {...fp("price")} label="Price" hint="The agreed total for the whole order. Leave empty if not priced yet.">
          <input type="number" min="0" step="any" value={v.price} onChange={set('price')} />
        </Field>
        <Field {...fp("deadline")} label="Deadline" hint="Leave empty if unknown.">
          <input type="datetime-local" value={v.deadline} onChange={set('deadline')} />
        </Field>
        {showStatus && (
          <>
            <Field {...fp("status")} label="Order status">
              <select value={v.status} onChange={set('status')}>{ORDER_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select>
            </Field>
            <Field {...fp("paymentStatus")} label="Payment status">
              <select value={v.paymentStatus} onChange={set('paymentStatus')}>{PAYMENT_STATUSES.map((s) => <option key={s} value={s}>{PAYMENT_LABEL[s]}</option>)}</select>
            </Field>
          </>
        )}
      </div>
      {serverErrors.filter((e) => !e.field || !Object.keys(v).includes(e.field)).map((e, i) => <p key={i} className="field-note error" role="alert">{e.field ? `${e.field}: ` : ''}{e.message}</p>)}
      <div className="form-actions">
        {onCancel && <button type="button" className="btn" onClick={onCancel} disabled={submitting}>Cancel</button>}
        <button type="submit" className="btn btn-primary" disabled={submitting}>{submitting ? 'Saving…' : submitLabel}</button>
      </div>
    </form>
  );
}

// ---------- DraftOrder ----------
// message -> AI draft -> seller reviews/edits -> explicit confirm -> real order. Nothing is saved before the confirm step.
export function DraftOrder({ message: initialMessage = '', source: initialSource = 'whatsapp', customerName, conversationId, editable = false, autoStart = false, onCancel, onCreated }) {
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
