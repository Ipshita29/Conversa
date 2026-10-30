import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Clock, Plus, RotateCcw } from 'lucide-react';
import { createOrder, simulatePlanner } from '../services/api.js';
import { formatMinutes, formatTimeInTz, formatInTz, fromLocalInput, toLocalInput } from '../utils/format.js';
import { validateOrder } from '../utils/validateOrder.js';
import { rushImpact } from '../utils/roadmap.js';
import { Modal } from './UI.jsx';

const slotText = (g, tz) => `${formatTimeInTz(g.start, tz)} – ${formatTimeInTz(g.end, tz)}`;
const free = (m) => (m >= 60 && m % 60 === 0 ? `${m / 60} ${m === 60 ? 'hour' : 'hours'} free` : `${formatMinutes(m)} free`);
const STATUS_CLASS = { overdue: 'is-overdue', onTrack: 'is-ontrack', upcoming: 'is-upcoming' };

export function TaskRow({ row, tz, next, onWhatIf }) {
  const partial = row.minutes < row.prep;
  return (
    <li className={`rm-row rm-task${next ? ' is-next' : ''}${row.section === 'overdue' ? ' is-late' : ''}`}>
      <time className="rm-time">{formatTimeInTz(row.start, tz)}<small>{formatTimeInTz(row.end, tz)}</small></time>
      <span className="rm-node" aria-hidden="true" />
      <article className="rm-card">
        {next && <p className="rm-next">Next up</p>}
        <header className="rm-card-head">
          <div>
            <h3>{row.customerName}{row.isDemo && <span className="demo-tag">Demo</span>}</h3>
            <p className="rm-what">{row.item}<span> × {row.quantity}</span></p>
          </div>
          <em className={`rm-status ${STATUS_CLASS[row.section]}`}>{row.label}</em>
        </header>
        <dl className="rm-facts">
          <div><dt>Make</dt><dd>{formatTimeInTz(row.start, tz)} → {formatTimeInTz(row.end, tz)}</dd></div>
          <div><dt>Prep</dt><dd>{formatMinutes(row.prep)}{partial && <small> · {formatMinutes(row.minutes)} today</small>}</dd></div>
          <div><dt>Deliver by</dt><dd>{row.deadline ? formatInTz(row.deadline, tz) : '—'}</dd></div>
        </dl>
        {row.section !== 'onTrack' && row.reason && <p className="rm-reason">{row.reason}</p>}
        <footer className="rm-card-foot">
          <Link to={`/orders?edit=${row.id}`}>Open order</Link>
          <button type="button" onClick={() => onWhatIf(row)}>Test a different deadline <ArrowRight size={12} aria-hidden="true" /></button>
        </footer>
      </article>
    </li>
  );
}

export function GapRow({ gap, tz, skipped, onRush, onSkip, onRestore }) {
  if (skipped) {
    return (
      <li className="rm-row rm-gap is-skipped">
        <time className="rm-time">{formatTimeInTz(gap.start, tz)}</time>
        <span className="rm-node" aria-hidden="true" />
        <div className="rm-skip"><span>Skipped · {formatMinutes(gap.minutes)} kept clear</span><button type="button" onClick={onRestore}><RotateCcw size={12} aria-hidden="true" /> Restore</button></div>
      </li>
    );
  }
  return (
    <li className="rm-row rm-gap">
      <time className="rm-time">{formatTimeInTz(gap.start, tz)}<small>{formatTimeInTz(gap.end, tz)}</small></time>
      <span className="rm-node" aria-hidden="true" />
      <section className="rm-free" aria-label="Available capacity">
        <p className="rm-free-tag">Available capacity</p>
        <h3>{slotText(gap, tz)} <span>· {free(gap.minutes)}</span></h3>
        <p className="rm-free-note">{gap.canRush ? 'Room for a rush order.' : 'Too short for another order.'}</p>
        {gap.canRush && (
          <div className="rm-free-actions">
            <button type="button" className="btn btn-primary" onClick={onRush}><Plus size={15} aria-hidden="true" /> Add rush order</button>
            <button type="button" className="btn" onClick={onSkip}>Skip this slot</button>
          </div>
        )}
      </section>
    </li>
  );
}

const Fld = ({ label, error, hint, wide, children }) => (
  <label className={`field${error ? ' has-error' : ''}${wide ? ' rm-wide' : ''}`}>
    <span className="field-label">{label}</span>{children}
    {error ? <span className="field-note error" role="alert">{error}</span> : hint && <span className="field-hint">{hint}</span>}
  </label>
);

// "Add rush order": the order is run through the real scheduler (the What-if simulation) before anything is saved.
export function RushModal({ gap, tz, orders, onClose, onAccepted }) {
  const [f, setF] = useState({ customerName: '', item: '', quantity: '1', prep: String(Math.min(gap.minutes, 60)), deadline: toLocalInput(gap.end) });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState(null);
  const [res, setRes] = useState(null);
  const set = (k) => (e) => { setF((x) => ({ ...x, [k]: e.target.value })); setRes(null); setFail(null); };

  const payload = () => ({ customerName: f.customerName.trim(), item: f.item.trim(), quantity: Number(f.quantity), prepTimeMinutes: f.prep === '' ? null : Number(f.prep), deadline: fromLocalInput(f.deadline), source: 'manual' });
  function validate() {
    const o = payload(); const e = {};
    for (const d of validateOrder(o)) e[d.field] = d.message;
    if (o.prepTimeMinutes === null || !(o.prepTimeMinutes >= 5)) e.prepTimeMinutes = 'Enter the preparation time in minutes (at least 5).';
    else if (o.prepTimeMinutes > gap.minutes) e.prepTimeMinutes = `This slot only has ${formatMinutes(gap.minutes)} free.`;
    if (!o.deadline) e.deadline = 'A delivery deadline is needed to check the fit.';
    else if (Date.parse(o.deadline) < Date.parse(gap.start) + (o.prepTimeMinutes ?? 0) * 60000) e.deadline = 'The deadline is before this job could finish.';
    setErrors(e);
    return Object.keys(e).length === 0 ? o : null;
  }
  async function check(ev) {
    ev.preventDefault();
    const o = validate(); if (!o) return;
    setBusy(true); setFail(null);
    try { setRes(rushImpact(await simulatePlanner({ days: 30, probeMinutes: 15, changes: [{ type: 'add_order', order: o }] }), orders)); }
    catch (err) { setFail(err.message); } finally { setBusy(false); }
  }
  async function accept() {
    const o = validate(); if (!o) return;
    setBusy(true); setFail(null);
    try { await createOrder(o); onAccepted(o); }
    catch (err) { setFail(err.message); setBusy(false); }
  }
  return (
    <Modal title="Add rush order" onClose={onClose}>
      <p className="rm-modal-slot">{slotText(gap, tz)} · {free(gap.minutes)}</p>
      <form onSubmit={check} noValidate>
        <div className="form-grid">
          <Fld label="Customer *" error={errors.customerName}><input value={f.customerName} onChange={set('customerName')} /></Fld>
          <Fld label="Product *" error={errors.item}><input value={f.item} onChange={set('item')} /></Fld>
          <Fld label="Quantity" error={errors.quantity}><input type="number" min="1" step="1" value={f.quantity} onChange={set('quantity')} /></Fld>
          <Fld label="Preparation time (minutes) *" error={errors.prepTimeMinutes}><input type="number" min="5" max={gap.minutes} step="5" value={f.prep} onChange={set('prep')} /></Fld>
          <Fld label="Delivery deadline *" error={errors.deadline} hint="Later than your other deadlines keeps their order. An earlier one can move them." wide><input type="datetime-local" value={f.deadline} onChange={set('deadline')} /></Fld>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy && !res ? 'Checking…' : 'Check the fit'}</button>
        </div>
      </form>
      {fail && <div className="notice error" role="alert">{fail}</div>}
      {res && <RushResult res={res} tz={tz} busy={busy} onAccept={accept} />}
    </Modal>
  );
}

function RushResult({ res, tz, busy, onAccept }) {
  const { mine, moved, hurt, fits, tight } = res;
  return (
    <div className={`rm-result ${fits ? 'is-fit' : 'is-nofit'}`} role="status">
      <h3>{fits ? 'It fits without making anyone late.' : 'It does not fit safely.'}</h3>
      {mine?.scheduledEnd && <p className="rm-result-line"><Clock size={14} aria-hidden="true" /> Made {formatInTz(mine.scheduledStart, tz)} → {formatInTz(mine.scheduledEnd, tz)}{tight && ' · tight against its deadline'}</p>}
      {!mine?.scheduledEnd && <p className="rm-result-line">{mine?.reason ?? 'It cannot be scheduled.'}</p>}
      {hurt.length > 0 && (
        <ul className="rm-impact">{hurt.map((h) => <li key={h.orderId}><b>{h.name}</b> would become {h.risk === 'high' ? 'late' : 'tight'}. {h.reason}</li>)}</ul>
      )}
      {moved.length > 0 && hurt.length === 0 && (
        <>
          <p className="rm-result-line">{moved.length} existing {moved.length === 1 ? 'order moves' : 'orders move'} later, still on time:</p>
          <ul className="rm-impact">{moved.map((m) => <li key={m.id}><b>{m.name}</b> now finishes {formatInTz(m.now, tz)} ({m.delta > 0 ? '+' : '−'}{formatMinutes(Math.abs(m.delta))})</li>)}</ul>
        </>
      )}
      {moved.length === 0 && hurt.length === 0 && mine?.scheduledEnd && <p className="rm-result-line">No existing order changes.</p>}
      {fits && <div className="form-actions"><button type="button" className="btn btn-primary" onClick={onAccept} disabled={busy}>{busy ? 'Adding…' : 'Accept rush order'}</button></div>}
      {!fits && <p className="rm-result-line">Try a shorter job or a later deadline.</p>}
    </div>
  );
}
