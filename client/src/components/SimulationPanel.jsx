import { useEffect, useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { simulatePlanner, createOrder, updateOrder } from '../services/api.js';
import { formatInTz, formatMinutes, toLocalInput, fromLocalInput, OPEN } from '../utils/format.js';
import SectionHead from './SectionHead.jsx';
import { RiskBadge } from './Badge.jsx';

const RANK = { high: 0, medium: 1, low: 2 };
const EMPTY = { customerName: '', item: '', prep: '', deadline: '', orderId: '' };

// Runs POST /planner/simulate. A simulation is read-only on the server; saving is a separate, explicitly confirmed action.
export default function SimulationPanel({ planner, orders, onApplied, prefill, eyebrow = 'What-if', title = 'What if another order comes in?', subtitle = "Try a rush order before committing. Understand the impact on the work you've already promised." }) {
  const tz = planner.range.timezone;
  const openOrders = orders.filter((o) => OPEN.includes(o.status));
  const [mode, setMode] = useState('add');
  const [form, setForm] = useState(EMPTY);
  const [sim, setSim] = useState(null); // { change, result }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // "Simulate a schedule change" / "Try this deadline" from the deadlines list: preselect the order and deadline.
  // It only fills the form; the seller still runs the simulation, and nothing is saved.
  useEffect(() => {
    if (!prefill) return;
    setMode('change'); setSim(null); setError(null); setDone(null); setConfirming(false);
    setForm({ ...EMPTY, orderId: prefill.orderId, deadline: toLocalInput(prefill.deadline) });
  }, [prefill?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const ready = mode === 'add' ? form.customerName.trim() && form.item.trim() && form.prep !== '' && Number(form.prep) >= 0 && form.deadline : form.orderId && form.deadline;

  const buildChange = () => (mode === 'add'
    ? { type: 'add_order', order: { customerName: form.customerName.trim(), item: form.item.trim(), quantity: 1, prepTimeMinutes: Number(form.prep), deadline: fromLocalInput(form.deadline), source: 'manual' } }
    : { type: 'update_order', orderId: form.orderId, order: { deadline: fromLocalInput(form.deadline) } });

  async function run(e) {
    e?.preventDefault();
    setBusy(true); setError(null); setConfirming(false); setDone(null);
    const change = buildChange();
    try { setSim({ change, result: await simulatePlanner({ changes: [change], days: planner.range.days }) }); }
    catch (err) { setSim(null); setError(err); }
    finally { setBusy(false); }
  }
  function discard() { setSim(null); setError(null); setConfirming(false); setForm(EMPTY); }

  async function accept() {
    setBusy(true); setError(null);
    try {
      if (sim.change.type === 'add_order') await createOrder(sim.change.order);
      else await updateOrder(sim.change.orderId, sim.change.order);
      setDone(sim.change.type === 'add_order' ? 'The order was saved. Your schedule and deadlines have been updated.' : 'The new deadline was saved. Your schedule has been updated.');
      setSim(null); setConfirming(false); setForm(EMPTY);
      onApplied?.();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  // ---- derive the display from the engine's before/after schedules (no recalculation) ----
  let view = null;
  if (sim) {
    const byId = Object.fromEntries(orders.map((o) => [o.id, o]));
    const before = Object.fromEntries((planner.schedule ?? []).map((s) => [s.orderId, s]));
    const afterList = sim.result.planner.schedule ?? [];
    const after = Object.fromEntries(afterList.map((s) => [s.orderId, s]));
    const targetId = sim.change.type === 'add_order' ? 'change_0' : sim.change.orderId;
    const nameOf = (id) => (id.startsWith('change_') ? `Proposed: ${sim.change.order.customerName}` : byId[id]?.customerName ?? id);
    const rows = Object.keys({ ...before, ...after })
      .filter((id) => !before[id] || !after[id] || before[id].risk !== after[id].risk || before[id].scheduledEnd !== after[id].scheduledEnd)
      .sort((a, b) => (a === targetId ? -1 : b === targetId ? 1 : (RANK[after[a]?.risk] ?? 3) - (RANK[after[b]?.risk] ?? 3)));
    const target = after[targetId];
    const changedRisk = rows.filter((id) => id !== targetId && before[id] && after[id] && before[id].risk !== after[id].risk).length;
    view = { before, after, rows, target, targetId, nameOf, changedRisk, comparison: sim.result.comparison };
  }

  const verdict = () => {
    const { target } = view;
    const what = sim.change.type === 'add_order' ? 'the proposed order' : `${view.nameOf(view.targetId)}'s order`;
    if (!target) return { tone: 'details', text: `The engine could not schedule ${what}: it needs a preparation time and a deadline.` };
    const buf = formatMinutes(Math.abs(target.bufferMinutes ?? 0));
    if (target.risk === 'low') return { tone: 'low', text: `Yes, it fits. ${what[0].toUpperCase() + what.slice(1)} should finish ${formatInTz(target.scheduledEnd, tz)}, with about ${buf} to spare.` };
    if (target.risk === 'medium') return { tone: 'medium', text: `It fits, but only just. Estimated finish ${formatInTz(target.scheduledEnd, tz)}: ${buf} before the deadline.` };
    return { tone: 'high', text: target.scheduledEnd ? `Not as requested. It would finish ${formatInTz(target.scheduledEnd, tz)}, ${buf} after the deadline.` : 'Not as requested. It cannot be scheduled within the planning horizon.' };
  };

  return (
    <>
      <SectionHead eyebrow={eyebrow} title={title}>{subtitle}</SectionHead>
      <div className="sim">
        <form className="sim-form" onSubmit={run}>
          <div className="seg" role="radiogroup" aria-label="Scenario type">
            <button type="button" role="radio" aria-checked={mode === 'add'} className={mode === 'add' ? 'is-on' : ''} onClick={() => { setMode('add'); setSim(null); }}>Add a rush order</button>
            <button type="button" role="radio" aria-checked={mode === 'change'} className={mode === 'change' ? 'is-on' : ''} onClick={() => { setMode('change'); setSim(null); }}>Change a deadline</button>
          </div>
          <div className="form-grid">
            {mode === 'add' ? (
              <>
                <label className="field"><span className="field-label">Customer *</span><input value={form.customerName} onChange={set('customerName')} placeholder="e.g. Nikhil" /></label>
                <label className="field"><span className="field-label">Item *</span><input value={form.item} onChange={set('item')} placeholder="e.g. 30 cake pops" /></label>
                <label className="field"><span className="field-label">Preparation time (minutes) *</span><input type="number" min="0" step="5" value={form.prep} onChange={set('prep')} placeholder="240" /></label>
              </>
            ) : (
              <label className="field"><span className="field-label">Order *</span>
                <select value={form.orderId} onChange={(e) => { const o = openOrders.find((x) => x.id === e.target.value); setForm((f) => ({ ...f, orderId: e.target.value, deadline: toLocalInput(o?.deadline) })); }}>
                  <option value="">Select an order…</option>
                  {openOrders.map((o) => <option key={o.id} value={o.id}>{o.customerName} — {o.item}</option>)}
                </select>
              </label>
            )}
            <label className="field"><span className="field-label">{mode === 'add' ? 'Requested deadline *' : 'New deadline *'}</span><input type="datetime-local" value={form.deadline} onChange={set('deadline')} /></label>
          </div>
          <div className="form-actions">
            {(sim || form !== EMPTY) && <button type="button" className="btn" onClick={discard} disabled={busy}>Discard</button>}
            <button type="submit" className="btn btn-primary" disabled={!ready || busy}><FlaskConical size={15} aria-hidden="true" />{busy && !sim ? 'Simulating…' : sim ? 'Rerun simulation' : 'Simulate impact'}</button>
          </div>
        </form>

        {error && <div className="notice error" role="alert">{error.message}{error.details?.map((d, i) => <div key={i}>{d.field}: {d.message}</div>)}</div>}
        {done && <div className="notice ok" role="status">{done}</div>}

        {sim && (
          <div className="sim-result" aria-live="polite">
            <p className="sim-label">Simulation — nothing has been saved</p>
            {(() => { const v = verdict(); return <p className={`verdict verdict-${v.tone}`}><RiskBadge risk={v.tone === 'details' ? null : v.tone} needsDetails={v.tone === 'details'} /> <span>{v.text}</span></p>; })()}
            <p className="sim-impact">
              Pending workload <b>{view.comparison.pendingMinutesDelta >= 0 ? '+' : '−'}{formatMinutes(Math.abs(view.comparison.pendingMinutesDelta))}</b>
              {' · '}Utilisation <b>{view.comparison.currentWorkload.utilisationPercent}% → {view.comparison.simulatedWorkload.utilisationPercent}%</b>
              {' · '}<b>{view.changedRisk}</b> existing {view.changedRisk === 1 ? 'order changes' : 'orders change'} risk level
            </p>

            <div className="table-wrap">
              <table className="table compare">
                <caption className="sr-only">Orders affected by this scenario, before and after</caption>
                <thead><tr><th>Order</th><th>Before</th><th>After</th><th>Why</th></tr></thead>
                <tbody>
                  {view.rows.map((id) => (
                    <tr key={id}>
                      <th scope="row">{view.nameOf(id)}</th>
                      <td>{view.before[id] ? <><RiskBadge risk={view.before[id].risk} /><small>{formatInTz(view.before[id].scheduledEnd, tz)}</small></> : <span className="muted">New</span>}</td>
                      <td>{view.after[id] ? <><RiskBadge risk={view.after[id].risk} /><small>{formatInTz(view.after[id].scheduledEnd, tz)}</small></> : <span className="muted">—</span>}</td>
                      <td>{view.after[id]?.reason ?? '—'}</td>
                    </tr>
                  ))}
                  {view.rows.length === 0 && <tr><td colSpan="4" className="muted">No existing order is affected.</td></tr>}
                </tbody>
              </table>
            </div>

            {view.comparison.suggestedAdjustments.length > 0 && (
              <div className="suggest">
                <h3>Suggested adjustments</h3>
                <ul>{view.comparison.suggestedAdjustments.map((s, i) => <li key={i}><b>{view.nameOf(s.orderId)}:</b> {s.explanation}</li>)}</ul>
              </div>
            )}

            <div className="form-actions">
              <button type="button" className="btn" onClick={discard} disabled={busy}>Discard scenario</button>
              {!confirming
                ? <button type="button" className="btn btn-primary" onClick={() => setConfirming(true)}>{sim.change.type === 'add_order' ? 'Accept this order…' : 'Apply this deadline…'}</button>
                : (
                  <>
                    <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={busy}>Not yet</button>
                    <button type="button" className="btn btn-primary" disabled={busy} onClick={accept}>{busy ? 'Saving…' : sim.change.type === 'add_order' ? 'Yes, save it as a real order' : 'Yes, save the new deadline'}</button>
                  </>
                )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
