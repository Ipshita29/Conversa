import { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { AlertTriangle, GripVertical, MessageCircle, Camera, PenLine, Pencil, Sparkles } from 'lucide-react';
import { validateOrder, ORDER_STATUSES, PAYMENT_STATUSES, SOURCES } from '../utils/validateOrder.js';
import { STATUS_LABEL, PAYMENT_LABEL, CHANNEL_LABEL, OPEN, toLocalInput, fromLocalInput, formatInTz, formatDateTime, formatMinutes, formatMoney, isDemoOrder } from '../utils/format.js';
import { Modal, RiskBadge } from './UI.jsx';
import useAsync from '../hooks/useAsync.js';
import { needsRecovery, situationOf, proposeRevision, buildMessage, customerFirstName, copyText } from '../utils/recoveryMessage.js';
import { extractOrder, createOrder, updateConversation, updateOrder, getPlanner, simulatePlanner, DEMO_MODE } from '../services/api.js';

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
// `board` is the Add-order dialog on the Orders board: it adds the date/time the order was placed, shows both statuses, and lists payment as Due / Partial / Paid.
const BOARD_PAYMENT = [['unverified', 'Due'], ['partial', 'Partial'], ['verified', 'Paid']];
export function OrderForm({ initial = {}, missing = [], uncertain = {}, serverErrors = [], submitting, submitLabel = 'Save order', showStatus = false, board = false, onSubmit, onCancel }) {
  const [v, setV] = useState({
    customerName: initial.customerName ?? '',
    item: initial.item ?? '',
    quantity: initial.quantity ?? 1,
    source: initial.source ?? 'manual',
    prepTimeMinutes: initial.prepTimeMinutes ?? '',
    price: initial.price ?? '',
    deadline: toLocalInput(initial.deadline),
    createdAt: toLocalInput(initial.createdAt ?? (board ? new Date().toISOString() : null)),
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
    if (board) payload.createdAt = v.createdAt ? fromLocalInput(v.createdAt) : new Date().toISOString();
    const errs = validateOrder(payload);
    setClientErrors(errs);
    if (errs.length === 0) onSubmit(payload);
  }

  // Props for the module-level <Field>, so inputs keep focus between renders.
  const fp = (name) => ({ name, error: errorFor(name), isMissing: missing.includes(name) && !errorFor(name), note: uncertain[name] });

  const payOptions = board ? BOARD_PAYMENT : PAYMENT_STATUSES.map((s) => [s, PAYMENT_LABEL[s]]);
  const F = {
    customerName: <Field key="customerName" {...fp('customerName')} label="Customer name *"><input value={v.customerName} onChange={set('customerName')} maxLength={120} /></Field>,
    source: <Field key="source" {...fp('source')} label="Channel">
      <select value={v.source} onChange={set('source')}>{SOURCES.map((s) => <option key={s} value={s}>{CHANNEL_LABEL[s]}</option>)}</select>
    </Field>,
    item: <Field key="item" {...fp('item')} label={board ? 'Product *' : 'Item *'}><input value={v.item} onChange={set('item')} maxLength={200} /></Field>,
    quantity: <Field key="quantity" {...fp('quantity')} label="Quantity"><input type="number" min="0" step="any" value={v.quantity} onChange={set('quantity')} /></Field>,
    prepTimeMinutes: <Field key="prepTimeMinutes" {...fp('prepTimeMinutes')} label="Preparation time (minutes)" hint="Leave empty if unknown. The order will be left out of capacity planning.">
      <input type="number" min="0" step="1" value={v.prepTimeMinutes} onChange={set('prepTimeMinutes')} />
    </Field>,
    price: <Field key="price" {...fp('price')} label={board ? 'Amount' : 'Price'} hint="The agreed total for the whole order. Leave empty if not priced yet.">
      <input type="number" min="0" step="any" value={v.price} onChange={set('price')} />
    </Field>,
    deadline: <Field key="deadline" {...fp('deadline')} label={board ? 'Delivery deadline' : 'Deadline'} hint="Leave empty if unknown.">
      <input type="datetime-local" value={v.deadline} onChange={set('deadline')} />
    </Field>,
    createdAt: <Field key="createdAt" {...fp('createdAt')} label="Order date and time" hint="When the customer placed the order.">
      <input type="datetime-local" value={v.createdAt} onChange={set('createdAt')} />
    </Field>,
    paymentStatus: <Field key="paymentStatus" {...fp('paymentStatus')} label="Payment status">
      <select value={v.paymentStatus} onChange={set('paymentStatus')}>{payOptions.map(([s, label]) => <option key={s} value={s}>{label}</option>)}</select>
    </Field>,
    status: <Field key="status" {...fp('status')} label="Order status">
      <select value={v.status} onChange={set('status')}>{ORDER_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select>
    </Field>,
  };
  const order = board
    ? ['customerName', 'item', 'quantity', 'createdAt', 'deadline', 'price', 'paymentStatus', 'status', 'source', 'prepTimeMinutes']
    : ['customerName', 'source', 'item', 'quantity', 'prepTimeMinutes', 'price', 'deadline', ...(showStatus ? ['status', 'paymentStatus'] : [])];

  return (
    <form className="order-form" onSubmit={submit} noValidate>
      <div className="form-grid">{order.map((k) => F[k])}</div>
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

// ---------- RecoveryPanel ----------
// Shown inside an expanded order that the scheduler marks overdue or at risk: why, a revised time the scheduler can meet, and an editable
// message to copy. It never sends anything and never changes the order's deadline unless the owner confirms "Update deadline".
export function RecoveryPanel({ order, onChanged }) {
  const plan = useAsync(() => getPlanner({ days: 7 }), [order.id, order.deadline]);
  const tz = plan.data?.range?.timezone;
  const entry = plan.data?.schedule?.find((e) => e.orderId === order.id);
  const [revision, setRevision] = useState(null);   // null while the scheduler checks a time
  const [proposed, setProposed] = useState('');     // local datetime-local value, editable
  const [variant, setVariant] = useState(0);
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [copied, setCopied] = useState(null);       // null | 'ok' | 'fail'
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const area = useRef(null);

  const active = Boolean(entry && needsRecovery(order, entry));
  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    setRevision(null);
    proposeRevision({ order, entry, simulate: simulatePlanner })
      .then((r) => { if (!live) return; setRevision(r); setProposed(r.kind === 'revised' ? toLocalInput(r.deadline) : ''); setVariant(0); setDirty(false); setText(buildMessage({ order, entry, revision: r, tz }).text); })
      .catch(() => { if (live) setRevision({ kind: 'none', reason: 'The scheduler could not check a new time just now.' }); });
    return () => { live = false; };
  }, [active, entry?.scheduledEnd, order.id, order.deadline]); // eslint-disable-line react-hooks/exhaustive-deps

  if (plan.status === 'loading' && !plan.data) return <p className="rc-note">Checking the schedule…</p>;
  if (plan.status === 'error') return <p className="rc-note" role="alert">Couldn't load the schedule for a recovery message. <button type="button" className="od-clear" onClick={plan.reload}>Try again</button></p>;
  if (!active) return null;

  const effective = revision?.kind === 'revised' && proposed && !Number.isNaN(Date.parse(fromLocalInput(proposed))) ? { kind: 'revised', deadline: fromLocalInput(proposed) } : revision?.kind === 'revised' ? { kind: 'none' } : revision;
  const draft = (v, rev = effective) => buildMessage({ order, entry, revision: rev, tz, variant: v }).text;
  const situation = situationOf(entry);
  const canUpdate = revision?.kind === 'revised' && effective?.kind === 'revised' && Date.parse(effective.deadline) > Date.now() && effective.deadline !== order.deadline;

  function onTime(e) {
    setProposed(e.target.value); setConfirming(false);
    const iso = fromLocalInput(e.target.value);
    if (!dirty && iso && !Number.isNaN(Date.parse(iso))) setText(draft(variant, { kind: 'revised', deadline: iso }));
  }
  function regenerate() { const v = variant + 1; setVariant(v); setDirty(false); setCopied(null); setText(draft(v)); }
  async function copy() {
    const r = await copyText(text, { fallback: (t) => { const el = area.current; if (!el) return false; el.focus(); el.select(); return document.execCommand('copy'); } });
    setCopied(r.ok ? 'ok' : 'fail'); setTimeout(() => setCopied(null), 3000);
  }
  async function saveDeadline() {
    setSaving(true); setSaveError(null);
    try { await updateOrder(order.id, { deadline: effective.deadline }); setConfirming(false); onChanged?.(); plan.reload(); }
    catch (e) { setSaveError(e); } finally { setSaving(false); }
  }

  return (
    <section className="rc" aria-label="Customer recovery">
      <div className="rc-head">
        <p className="rc-label">Customer recovery</p>
        <p className={`rc-state is-${entry.risk}`}><i aria-hidden="true" />{situation === 'overdue' ? 'Overdue' : situation === 'tight' ? 'Tight' : situation === 'unschedulable' ? "Can't be scheduled" : 'Likely late'}<span>{entry.reason}</span></p>
      </div>
      <dl className="rc-times">
        <div><dt>Promised</dt><dd>{formatInTz(order.deadline, tz)}</dd></div>
        {revision === null ? <div><dt>Suggested</dt><dd className="rc-wait">Checking…</dd></div>
          : revision.kind === 'revised' ? <div><dt>Suggested</dt><dd><input type="datetime-local" value={proposed} onChange={onTime} aria-label="Proposed delivery time" /></dd></div>
            : revision.kind === 'estimate' ? <div><dt>Expected ready</dt><dd>{formatInTz(revision.finish, tz)}</dd></div>
              : <div><dt>Suggested</dt><dd className="rc-none">None. Needs your call</dd></div>}
      </dl>
      {revision?.kind === 'none' && <p className="rc-note">{revision.reason} The message below asks the customer for a time instead.</p>}
      {revision?.kind === 'revised' && effective?.kind === 'none' && <p className="rc-note">Enter a valid time, or the message will ask the customer for one.</p>}
      <label className="rc-msg"><span className="sr-only">Message to {customerFirstName(order)}</span>
        <textarea ref={area} rows={4} value={text} onChange={(e) => { setText(e.target.value); setDirty(true); setCopied(null); }} disabled={revision === null} /></label>
      <div className="rc-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={copy} disabled={!text.trim()}>{copied === 'ok' ? 'Copied!' : 'Copy message'}</button>
        <button type="button" className="btn btn-sm" onClick={regenerate} disabled={revision === null}>Regenerate</button>
        {canUpdate && !confirming && <button type="button" className="btn btn-sm" onClick={() => setConfirming(true)}>Update deadline…</button>}
        {confirming && <><span className="rc-confirm">Save {formatInTz(effective.deadline, tz)} as the new deadline?</span><button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={saveDeadline}>{saving ? 'Saving…' : 'Save'}</button><button type="button" className="btn btn-sm" onClick={() => setConfirming(false)} disabled={saving}>Not yet</button></>}
        <span className="rc-copied" role="status" aria-live="polite">{copied === 'ok' ? 'Ready to send. Nothing has been sent.' : copied === 'fail' ? "Couldn't copy. Select the text and copy it manually." : ''}</span>
      </div>
      {saveError && <p className="rc-note" role="alert">Couldn't update the deadline: {saveError.message}</p>}
    </section>
  );
}

// ---------- Kanban board ----------
// Four columns, one rule: where an order sits is worked out from its status and its payment, and a move only ever changes the STATUS.
// Payment is never touched by a drag, so a card can only be dropped where it would really belong once moved (see canMove).
export const COLUMNS = [
  { key: 'progress', title: 'In progress', hint: 'Being prepared' },
  { key: 'payment', title: 'Payment due', hint: 'Waiting to be paid' },
  { key: 'upcoming', title: 'Upcoming', hint: 'Paid and ready to start' },
  { key: 'done', title: 'Completed', hint: 'Delivered' },
];
const LOCKED = ['completed', 'cancelled']; // the API refuses to change these
export const isPaid = (o) => o.paymentStatus === 'verified';
export const columnOf = (o) => (LOCKED.includes(o.status) ? 'done' : o.status === 'in_progress' ? 'progress' : isPaid(o) ? 'upcoming' : 'payment');
export const statusFor = (o, col) => (col === 'done' ? 'completed' : col === 'progress' ? 'in_progress' : ['pending', 'confirmed'].includes(o.status) ? o.status : 'confirmed');
export const payTag = (o) => (o.paymentStatus === 'verified' ? { key: 'paid', label: 'Paid' } : o.paymentStatus === 'partial' ? { key: 'partial', label: 'Partial' } : { key: 'due', label: 'Due' });

// May this order be dropped in this column? Allowed only if, after the status change, it would really belong there.
export function canMove(o, col) {
  if (col === columnOf(o)) return { ok: true, same: true };
  if (LOCKED.includes(o.status)) return { ok: false, reason: `${STATUS_LABEL[o.status]} orders can't be reopened.` };
  if (columnOf({ ...o, status: statusFor(o, col) }) !== col) return { ok: false, reason: col === 'upcoming' ? 'Unpaid orders wait in Payment due until they are paid.' : 'This order is already paid.' };
  return { ok: true };
}

// "Overdue", "Today", "Tomorrow" or "In 3 days" for orders that are still open; nothing for finished ones.
export function relativeDue(o) {
  if (!o.deadline || !OPEN.includes(o.status)) return null;
  const d = new Date(o.deadline);
  if (d < new Date()) return { text: 'Overdue', tone: 'late' };
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const n = Math.round((day(d) - day(new Date())) / 864e5);
  return { text: n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `In ${n} days`, tone: n <= 1 ? 'soon' : null };
}

const CHANNEL_ICON = { whatsapp: MessageCircle, instagram: Camera, manual: PenLine };

function OrderCard({ o, dragging, onOpen, onStart, onMove, ignoreClick }) {
  const open = OPEN.includes(o.status);
  const late = open && (o.risk === 'high' || (o.deadline && new Date(o.deadline) < new Date()));
  const needsDetails = open && (o.prepTimeMinutes === null || !o.deadline);
  const rel = relativeDue(o);
  const pay = payTag(o);
  const col = columnOf(o);
  const Chan = CHANNEL_ICON[o.source] ?? PenLine;
  const targets = COLUMNS.filter((c) => c.key !== col && canMove(o, c.key).ok);
  return (
    <article data-card={o.id} className={`od-card${late ? ' is-late' : ''}${col === 'done' ? ' is-done' : ''}${dragging ? ' is-dragging' : ''}`}
      onPointerDown={(e) => onStart(e, o)} onClick={(e) => { if (ignoreClick() || e.target.closest('select')) return; onOpen(o.id); }}>
      <header className="od-card-top">
        <button type="button" className="od-card-name" aria-label={`Open ${o.customerName}'s order`}>{o.customerName}</button>
        {isDemoOrder(o) && <span className="demo-tag">Demo</span>}
        {!LOCKED.includes(o.status) && <span className="od-grip" data-grip aria-hidden="true"><GripVertical size={16} /></span>}
      </header>
      <p className="od-card-item">{o.item} <span>× {o.quantity}</span></p>
      <dl className="od-card-times">
        <div><dt>Placed</dt><dd>{o.createdAt ? formatDateTime(o.createdAt) : '—'}</dd></div>
        <div><dt>Deadline</dt><dd>{o.deadline ? formatDateTime(o.deadline) : <em>No deadline</em>}{rel && <b className={`od-rel${rel.tone ? ` is-${rel.tone}` : ''}`}>{rel.text}</b>}</dd></div>
      </dl>
      <div className="od-card-badges">
        <span className={`pay-tag pt-${pay.key}`} title={PAYMENT_LABEL[o.paymentStatus]}>{pay.label}{o.price != null && <> · {formatMoney(o.price)}</>}</span>
        <span className={`od-st st-${o.status}`}><i aria-hidden="true" />{STATUS_LABEL[o.status] ?? o.status}</span>
        {((open && (o.risk === 'high' || o.risk === 'medium')) || needsDetails) && <RiskBadge risk={o.risk} needsDetails={needsDetails && !(o.risk === 'high' || o.risk === 'medium')} />}
      </div>
      <footer className="od-card-foot">
        <span className="od-chan"><Chan size={13} aria-hidden="true" />{CHANNEL_LABEL[o.source]}</span>
        {targets.length > 0 && (
          <select className="od-move" value="" aria-label={`Move ${o.customerName}'s order`} onChange={(e) => e.target.value && onMove(o, e.target.value)}>
            <option value="">Move to…</option>
            {targets.map((c) => <option key={c.key} value={c.key}>{c.title}</option>)}
          </select>
        )}
      </footer>
    </article>
  );
}

// Pointer-based drag (mouse, pen and touch). A floating copy follows the pointer; the column under it lights up, or explains why it can't take the card.
// Touch drags start from the grip only, so the page can still scroll. Escape cancels. The page scrolls itself when the card nears the top or bottom edge.
function useBoardDrag(onDrop) {
  const [drag, setDrag] = useState(null); // { id, order, over }
  const st = useRef(null);
  const suppress = useRef(false);
  const live = useRef({ onDrop });
  live.current.onDrop = onDrop;

  useEffect(() => () => { st.current?.cleanup?.(); }, []);

  const start = (e, order) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const hit = e.target.closest('button, a, input, select, textarea');
    if (hit && !hit.classList.contains('od-card-name')) return; // the name opens the order on click but can also be grabbed
    if (LOCKED.includes(order.status)) return;
    if (e.pointerType === 'touch' && !e.target.closest('[data-grip]')) return;
    const card = e.currentTarget;
    const rect = card.getBoundingClientRect();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const s = { card, rect, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, dx: e.clientX - rect.left, dy: e.clientY - rect.top, active: false, ghost: null, over: null, raf: 0 };
    st.current = s;

    const place = () => {
      if (!s.ghost) return;
      s.ghost.style.transform = `translate3d(${s.x - s.dx}px, ${s.y - s.dy}px, 0) rotate(${reduce ? 0 : 1.6}deg) scale(1.02)`;
      if (s.y < 90) window.scrollBy(0, -16); else if (s.y > window.innerHeight - 90) window.scrollBy(0, 16);
      s.raf = requestAnimationFrame(place);
    };
    const colAt = () => document.elementsFromPoint(s.x, s.y).find((n) => n.dataset?.col)?.dataset.col ?? null;
    const move = (ev) => {
      s.x = ev.clientX; s.y = ev.clientY;
      if (!s.active) {
        if (Math.hypot(s.x - s.x0, s.y - s.y0) < 6) return;
        s.active = true;
        const g = card.cloneNode(true);
        g.classList.add('is-ghost'); g.removeAttribute('data-card');
        g.style.cssText = `position:fixed;left:0;top:0;width:${rect.width}px;margin:0;z-index:300;pointer-events:none;`;
        document.body.appendChild(g);
        s.ghost = g;
        document.body.classList.add('is-card-dragging');
        setDrag({ id: order.id, order, over: columnOf(order) });
        s.raf = requestAnimationFrame(place);
      }
      if (ev.cancelable) ev.preventDefault();
      const c = colAt();
      if (c !== s.over) { s.over = c; setDrag((d) => (d ? { ...d, over: c } : d)); }
    };
    const cleanup = () => {
      cancelAnimationFrame(s.raf);
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', key);
      document.body.classList.remove('is-card-dragging');
      s.ghost?.remove();
      st.current = null;
    };
    s.cleanup = cleanup;
    const finish = (cancelled) => {
      if (!s.active) { cleanup(); return; }
      suppress.current = true; setTimeout(() => { suppress.current = false; }, 0); // the click that follows a drag must not open the order
      const col = cancelled ? null : s.over;
      const verdict = col ? canMove(order, col) : { ok: false };
      const ghost = s.ghost;
      cancelAnimationFrame(s.raf);
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', key);
      document.body.classList.remove('is-card-dragging');
      st.current = null;
      setDrag(null);
      if (verdict.ok && !verdict.same) {
        ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140 }).onfinish = () => ghost.remove();
        live.current.onDrop(order, col);
      } else {
        const r = card.getBoundingClientRect(); // glide back to where the card is
        const a = ghost.animate([{ transform: ghost.style.transform }, { transform: `translate3d(${r.left}px, ${r.top}px, 0)` }], { duration: reduce ? 1 : 240, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' });
        a.onfinish = () => ghost.remove();
        if (col && !verdict.ok) live.current.onDrop(order, col, verdict);
      }
    };
    const up = () => finish(false);
    const cancel = () => finish(true);
    const key = (ev) => { if (ev.key === 'Escape') finish(true); };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
  };
  return { drag, start, ignoreClick: () => suppress.current };
}

export function KanbanBoard({ orders, onMove, onOpen }) {
  const boardRef = useRef(null);
  const prev = useRef(new Map());
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const byCol = useMemo(() => {
    const dl = (o) => (o.deadline ? Date.parse(o.deadline) : Infinity);
    return Object.fromEntries(COLUMNS.map((c) => [c.key, orders.filter((o) => columnOf(o) === c.key).sort((a, b) => (c.key === 'done' ? dl(b) - dl(a) : dl(a) - dl(b)))]));
  }, [orders]);
  const { drag, start, ignoreClick } = useBoardDrag(onMove);

  // Cards glide to their new place instead of jumping (a drop, a search, a status change).
  useLayoutEffect(() => {
    const root = boardRef.current;
    if (!root) return;
    const now = new Map();
    root.querySelectorAll('[data-card]').forEach((el) => {
      const r = el.getBoundingClientRect();
      const pos = { x: r.left + window.scrollX, y: r.top + window.scrollY };
      now.set(el.dataset.card, pos);
      const old = prev.current.get(el.dataset.card);
      if (old && !reduced && Math.abs(old.x - pos.x) + Math.abs(old.y - pos.y) > 2) {
        el.animate([{ transform: `translate(${old.x - pos.x}px, ${old.y - pos.y}px)` }, { transform: 'none' }], { duration: 340, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' });
      }
    });
    prev.current = now;
  });

  return (
    <div className={`od-board${drag ? ' is-dragging' : ''}`} ref={boardRef}>
      {COLUMNS.map((c) => {
        const verdict = drag ? canMove(drag.order, c.key) : null;
        const cls = drag ? (verdict.ok ? (drag.over === c.key ? ' is-over' : ' is-ok') : (drag.over === c.key ? ' is-blocked is-over' : ' is-blocked')) : '';
        return (
          <section key={c.key} data-col={c.key} className={`od-col od-col-${c.key}${cls}`} aria-label={`${c.title}, ${byCol[c.key].length} ${byCol[c.key].length === 1 ? 'order' : 'orders'}`}>
            <header className="od-col-head">
              <h2>{c.title}</h2><b>{byCol[c.key].length}</b>
              <p>{c.hint}</p>
            </header>
            <div className="od-col-body">
              {byCol[c.key].map((o) => (
                <OrderCard key={o.id} o={o} dragging={drag?.id === o.id} onOpen={onOpen} onStart={start} onMove={(order, col) => onMove(order, col)} ignoreClick={ignoreClick} />
              ))}
              {byCol[c.key].length === 0 && !drag && <p className="od-col-empty">Nothing here</p>}
              {drag && verdict && !verdict.ok && drag.over === c.key && <p className="od-col-note" role="status">{verdict.reason}</p>}
              {drag && verdict?.ok && !verdict.same && drag.over === c.key && <p className="od-col-note is-ok" role="status">Drop to move to {c.title}</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ---------- OrderDetails ----------
// What the old expanded row showed, in a dialog: the numbers, contact and notes, a status picker, Edit, and the customer-recovery panel for risky orders.
export function OrderDetails({ order: o, busy, onClose, onEdit, onStatus, onChanged }) {
  const open = OPEN.includes(o.status);
  return (
    <Modal title={`${o.customerName}${o.item ? ` · ${o.item}` : ''}`} onClose={onClose}>
      <div className="od-detail">
        <dl>
          <div><dt>Quantity</dt><dd>{o.quantity}</dd></div>
          <div><dt>Placed</dt><dd>{o.createdAt ? formatDateTime(o.createdAt) : '—'}</dd></div>
          <div><dt>Deadline</dt><dd>{o.deadline ? formatDateTime(o.deadline) : 'Not set'}</dd></div>
          <div><dt>Preparation</dt><dd>{o.prepTimeMinutes === null ? 'Not set' : formatMinutes(o.prepTimeMinutes)}</dd></div>
          <div><dt>Amount</dt><dd>{o.price == null ? 'Not set' : formatMoney(o.price)}</dd></div>
          <div><dt>Payment</dt><dd><span className={`pay-tag pt-${payTag(o).key}`}>{payTag(o).label}</span> <small>{PAYMENT_LABEL[o.paymentStatus]}</small></dd></div>
          <div><dt>Channel</dt><dd>{CHANNEL_LABEL[o.source]}</dd></div>
          {o.customerContact && <div><dt>Contact</dt><dd>{o.customerContact}</dd></div>}
          {o.customisation && <div><dt>Customisation</dt><dd>{o.customisation}</dd></div>}
          {o.notes && !isDemoOrder(o) && <div><dt>Notes</dt><dd>{o.notes}</dd></div>}
        </dl>
        <div className="od-actions">
          <label className="od-statuspick"><span>Status</span>
            <select className={`status-select status-${o.status}`} value={o.status} disabled={busy || LOCKED.includes(o.status)} onChange={(e) => onStatus(o, e.target.value)} aria-label={`Status for ${o.customerName}`}>
              {ORDER_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select></label>
          <button type="button" className="btn btn-sm" onClick={() => onEdit(o.id)} aria-label={`Edit ${o.customerName}'s order`}><Pencil size={13} aria-hidden="true" /> Edit</button>
        </div>
        {open && (o.risk === 'high' || o.risk === 'medium') && <RecoveryPanel order={o} onChanged={onChanged} />}
      </div>
    </Modal>
  );
}
