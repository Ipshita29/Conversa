import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { validateOrder, ORDER_STATUSES, PAYMENT_STATUSES, SOURCES } from '../utils/validateOrder.js';
import { STATUS_LABEL, PAYMENT_LABEL, CHANNEL_LABEL, toLocalInput, fromLocalInput } from '../utils/format.js';

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
export default function OrderForm({ initial = {}, missing = [], uncertain = {}, serverErrors = [], submitting, submitLabel = 'Save order', showStatus = false, onSubmit, onCancel }) {
  const [v, setV] = useState({
    customerName: initial.customerName ?? '',
    item: initial.item ?? '',
    quantity: initial.quantity ?? 1,
    source: initial.source ?? 'manual',
    prepTimeMinutes: initial.prepTimeMinutes ?? '',
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
