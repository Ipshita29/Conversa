import { useEffect, useState } from 'react';
import { FlaskConical, RotateCcw, Sparkles } from 'lucide-react';
import { simulatePlanner, createOrder, updateOrder } from '../services/api.js';
import { formatInTz, formatTimeInTz, formatMinutes, toLocalInput, fromLocalInput, isDemoOrder, OPEN } from '../utils/format.js';
import SectionHead from './SectionHead.jsx';
import StateMessage from './StateMessage.jsx';
import { RiskBadge } from './Badge.jsx';

const RANK = { high: 0, medium: 1, low: 2 };
const EMPTY = { customerName: '', item: '', prep: '', deadline: '', orderId: '' };
const PROBES = [30, 60, 90, 120];

// Everything shown after a run is the response of POST /planner/simulate. It is read-only on the server;
// saving is a separate, explicitly confirmed call to the normal order endpoints.
export default function SimulationPanel({ planner, orders, onApplied, prefill, eyebrow = 'What-if', title = 'What if you changed the schedule?', subtitle = "Test a change before you commit to it. See exactly what it does to your deadlines and to the free time you have left." }) {
  const tz = planner.range.timezone;
  const days = planner.range.days;
  const suggestion = planner.suggestedScenario ?? null;
  const openOrders = orders.filter((o) => OPEN.includes(o.status));
  const byId = Object.fromEntries(orders.map((o) => [o.id, o]));

  const [mode, setMode] = useState('add');
  const [form, setForm] = useState(EMPTY);
  const [sim, setSim] = useState(null); // { change, result, source }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [lastRun, setLastRun] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(null);
  const [probe, setProbe] = useState(60);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // "Simulate" / "Try the suggested deadline" elsewhere on the page preselect the order and deadline. Nothing runs or saves.
  useEffect(() => {
    if (!prefill) return;
    setMode('change'); setSim(null); setError(null); setDone(null); setConfirming(false);
    setForm({ ...EMPTY, orderId: prefill.orderId, deadline: toLocalInput(prefill.deadline) });
  }, [prefill?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const ready = mode === 'add' ? form.customerName.trim() && form.item.trim() && form.prep !== '' && Number(form.prep) >= 0 && form.deadline
    : mode === 'prep' ? form.orderId && form.prep !== '' && Number(form.prep) >= 0 : form.orderId && form.deadline;
  const buildChange = () => (mode === 'add'
    ? { type: 'add_order', order: { customerName: form.customerName.trim(), item: form.item.trim(), quantity: 1, prepTimeMinutes: Number(form.prep), deadline: fromLocalInput(form.deadline), source: 'manual' } }
    : mode === 'prep' ? { type: 'update_order', orderId: form.orderId, order: { prepTimeMinutes: Number(form.prep) } }
      : { type: 'update_order', orderId: form.orderId, order: { deadline: fromLocalInput(form.deadline) } });

  async function runChange(change, source, probeMinutes = probe) {
    setBusy(true); setError(null); setConfirming(false); setDone(null); setLastRun({ change, source });
    try { setSim({ change, source, result: await simulatePlanner({ changes: [change], days, probeMinutes }) }); }
    catch (err) { setSim(null); setError(err); }
    finally { setBusy(false); }
  }
  const run = (e) => { e.preventDefault(); runChange(buildChange(), 'form'); };

  // Put a scenario into the form so it can be inspected and edited before (re)running it.
  function adjust(change) {
    setSim(null); setError(null); setDone(null); setConfirming(false);
    if (change.type === 'update_order' && change.order.prepTimeMinutes !== undefined) { setMode('prep'); setForm({ ...EMPTY, orderId: change.orderId, prep: String(change.order.prepTimeMinutes) }); }
    else if (change.type === 'update_order') { setMode('change'); setForm({ ...EMPTY, orderId: change.orderId, deadline: toLocalInput(change.order.deadline) }); }
    else { setMode('add'); setForm({ ...EMPTY, customerName: change.order.customerName, item: change.order.item, prep: String(change.order.prepTimeMinutes), deadline: toLocalInput(change.order.deadline) }); }
    document.getElementById('sim-form')?.scrollIntoView?.({ block: 'nearest' });
  }
  function discard() { setSim(null); setError(null); setConfirming(false); setForm(EMPTY); setLastRun(null); }

  async function apply() {
    setBusy(true); setError(null);
    try {
      if (sim.change.type === 'add_order') await createOrder(sim.change.order);
      else await updateOrder(sim.change.orderId, sim.change.order);
      setDone('Saved. Your priority list and deadline risks have been refreshed from the saved schedule.');
      setSim(null); setConfirming(false); setForm(EMPTY); setLastRun(null);
      onApplied?.();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  const nameOf = (id) => (id.startsWith('change_') ? `Proposed: ${sim?.change.order.customerName}` : byId[id]?.customerName ?? id);
  const win = (w) => (w ? `${formatInTz(w.start, tz)} to ${formatTimeInTz(w.end, tz)} (${formatMinutes(w.minutes)})` : 'None in the next ' + days + ' days');

  let view = null;
  if (sim) {
    const c = sim.result.comparison;
    const before = Object.fromEntries((planner.schedule ?? []).map((s) => [s.orderId, s]));
    const afterList = sim.result.planner.schedule ?? [];
    const after = Object.fromEntries(afterList.map((s) => [s.orderId, s]));
    const targetId = sim.change.type === 'add_order' ? 'change_0' : sim.change.orderId;
    const rows = Object.keys({ ...before, ...after })
      .filter((id) => !before[id] || !after[id] || before[id].risk !== after[id].risk || before[id].scheduledEnd !== after[id].scheduledEnd)
      .sort((a, b) => (a === targetId ? -1 : b === targetId ? 1 : (RANK[after[a]?.risk] ?? 3) - (RANK[after[b]?.risk] ?? 3)));
    view = { c, before, after, rows, targetId, target: after[targetId], changedRisk: rows.filter((id) => id !== targetId && before[id] && after[id] && before[id].risk !== after[id].risk).length };
  }

  const verdict = () => {
    const { target, targetId } = view;
    const what = sim.change.type === 'add_order' ? 'the proposed order' : `${nameOf(targetId)}'s order`;
    if (!target) return { tone: 'details', text: `The scheduler could not place ${what}: it needs a preparation time and a deadline.` };
    const buf = formatMinutes(Math.abs(target.bufferMinutes ?? 0));
    if (target.risk === 'low') return { tone: 'low', text: `Yes, it fits. ${what[0].toUpperCase() + what.slice(1)} should finish ${formatInTz(target.scheduledEnd, tz)}, about ${buf} before its deadline.` };
    if (target.risk === 'medium') return { tone: 'medium', text: `It fits, but only just. Estimated finish ${formatInTz(target.scheduledEnd, tz)}, ${buf} before the deadline.` };
    return { tone: 'high', text: target.scheduledEnd ? `Not as requested. It would finish ${formatInTz(target.scheduledEnd, tz)}, ${buf} after the deadline.` : 'Not as requested. It cannot be scheduled within the planning horizon.' };
  };

  // Plain-language reading of the engine's numbers.
  const summary = () => {
    const { c } = view;
    const names = (list) => list.map((r) => nameOf(r.orderId)).join(', ');
    const out = [];
    if (c.resolvedRisks.length) out.push(`Resolves ${c.resolvedRisks.length} deadline ${c.resolvedRisks.length === 1 ? 'risk' : 'risks'} (${names(c.resolvedRisks)}).`);
    out.push(c.newRisks.length ? `Introduces ${c.newRisks.length} new ${c.newRisks.length === 1 ? 'risk' : 'risks'} (${names(c.newRisks)}).` : 'Introduces no new risks.');
    if (!c.resolvedRisks.length && !c.newRisks.length) out.push('No order changes its risk level.');
    const goal = suggestion?.goalMinutes ?? 60;
    if ('simulatedNearFreeWindow' in c) {
      const nb = c.currentNearFreeWindow?.minutes ?? 0;
      const na = c.simulatedNearFreeWindow?.minutes ?? 0;
      if (na >= goal && nb < goal) out.push(`Yes, it creates an uninterrupted free hour in your next two working days: ${win(c.simulatedNearFreeWindow)}.`);
      else if (na >= goal) out.push(`You already have an uninterrupted free hour in your next two working days, and still do: ${win(c.simulatedNearFreeWindow)}.`);
      else out.push(`No, it does not create an uninterrupted free hour in your next two working days. ${na > 0 ? `The most you have free there is ${formatMinutes(na)}.` : 'Those days are fully booked.'}${c.simulatedLargestFreeWindow ? ` Later, your largest free window is ${win(c.simulatedLargestFreeWindow)}.` : ''}`);
    }
    if (c.fit) {
      out.push(c.fit.fits
        ? `Another ${formatMinutes(c.fit.minutes)} order would fit${c.fit.scope === 'later' ? ', but only later' : ''}: it could start ${formatInTz(c.fit.startsAt, tz)} and finish ${formatInTz(c.fit.finishesAt, tz)} without making any existing order later.`
        : `Another ${formatMinutes(c.fit.minutes)} order would not fit. ${c.fit.reason ?? ''}`.trim());
    }
    return out;
  };

  const metrics = () => {
    const { c } = view;
    const cw = c.currentWorkload; const sw = c.simulatedWorkload;
    const cc = c.currentCounts; const sc = c.simulatedCounts;
    const rows = [
      ['Pending preparation', formatMinutes(cw.pendingMinutes), formatMinutes(sw.pendingMinutes)],
      [`Available time (${days} days)`, formatMinutes(cw.availableMinutes), formatMinutes(sw.availableMinutes)],
      ['Utilisation', `${cw.utilisationPercent}%`, `${sw.utilisationPercent}%`],
    ];
    if (cc && sc) rows.push(['High-risk orders (conflicts)', cc.high, sc.high], ['Medium-risk orders', cc.medium, sc.medium], ['Needs details', cc.details, sc.details]);
    if ('simulatedNearFreeWindow' in c) rows.push(['Free hour in your next two working days', c.currentNearFreeWindow ? formatMinutes(c.currentNearFreeWindow.minutes) : 'None', c.simulatedNearFreeWindow ? formatMinutes(c.simulatedNearFreeWindow.minutes) : 'None']);
    if ('simulatedLargestFreeWindow' in c) rows.push([`Largest free window (${days} days)`, c.currentLargestFreeWindow ? formatMinutes(c.currentLargestFreeWindow.minutes) : 'None', c.simulatedLargestFreeWindow ? formatMinutes(c.simulatedLargestFreeWindow.minutes) : 'None']);
    return rows;
  };

  const sugOrder = suggestion?.changes[0]?.orderId ? byId[suggestion.changes[0].orderId] : null;
  const isAdd = sim?.change.type === 'add_order';

  return (
    <>
      <SectionHead eyebrow={eyebrow} title={title}>{subtitle}</SectionHead>
      <div className="sim">
        {suggestion && (
          <div className="sim-suggest">
            <p className="sim-label sim-label-accent"><Sparkles size={12} aria-hidden="true" /> Suggested experiment{sugOrder && isDemoOrder(sugOrder) && <span className="demo-tag">Demo order</span>}</p>
            <h3>{suggestion.title}</h3>
            <p>{suggestion.summary}</p>
            <p className="muted sim-why">{suggestion.why}</p>
            <div className="sim-suggest-actions">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => runChange(suggestion.changes[0], 'suggested')}><FlaskConical size={15} aria-hidden="true" />{busy && lastRun?.source === 'suggested' ? 'Simulating…' : 'Run this experiment'}</button>
              <button type="button" className="btn" disabled={busy} onClick={() => adjust(suggestion.changes[0])}>Inspect or adjust</button>
            </div>
          </div>
        )}

        <form className="sim-form" id="sim-form" onSubmit={run}>
          <p className="sim-form-title">Or build your own</p>
          <div className="seg" role="radiogroup" aria-label="Scenario type">
            <button type="button" role="radio" aria-checked={mode === 'add'} className={mode === 'add' ? 'is-on' : ''} onClick={() => { setMode('add'); setSim(null); }}>Add a rush order</button>
            <button type="button" role="radio" aria-checked={mode === 'change'} className={mode === 'change' ? 'is-on' : ''} onClick={() => { setMode('change'); setSim(null); }}>Change a deadline</button>
            <button type="button" role="radio" aria-checked={mode === 'prep'} className={mode === 'prep' ? 'is-on' : ''} onClick={() => { setMode('prep'); setSim(null); }}>Change preparation time</button>
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
                <select value={form.orderId} onChange={(e) => { const o = openOrders.find((x) => x.id === e.target.value); setForm((f) => ({ ...f, orderId: e.target.value, deadline: toLocalInput(o?.deadline), prep: o?.prepTimeMinutes ?? '' })); }}>
                  <option value="">Select an order…</option>
                  {openOrders.map((o) => <option key={o.id} value={o.id}>{o.customerName}: {o.item}</option>)}
                </select>
              </label>
            )}
            {mode === 'prep'
              ? <label className="field"><span className="field-label">New preparation time (minutes) *</span><input type="number" min="0" step="5" value={form.prep} onChange={set('prep')} /><span className="field-hint">An assumption to test, for example from batching or pre-making components.</span></label>
              : <label className="field"><span className="field-label">{mode === 'add' ? 'Requested deadline *' : 'New deadline *'}</span><input type="datetime-local" value={form.deadline} onChange={set('deadline')} /></label>}
          </div>
          <div className="form-actions">
            {(sim || form !== EMPTY) && <button type="button" className="btn" onClick={discard} disabled={busy}>Discard</button>}
            <button type="submit" className="btn btn-primary" disabled={!ready || busy}><FlaskConical size={15} aria-hidden="true" />{busy && lastRun?.source === 'form' ? 'Simulating…' : sim ? 'Rerun simulation' : 'Simulate impact'}</button>
          </div>
        </form>

        {error && (
          <div className="notice error" role="alert">
            Couldn't run the simulation: {error.message}{error.details?.map((d, i) => <div key={i}>{d.field}: {d.message}</div>)}
            {lastRun && <div><button type="button" className="btn btn-sm" onClick={() => runChange(lastRun.change, lastRun.source)} disabled={busy}><RotateCcw size={13} aria-hidden="true" /> Try again</button></div>}
          </div>
        )}
        {done && <div className="notice ok" role="status">{done}</div>}
        {busy && !sim && <StateMessage kind="loading" message="Asking the scheduler…" />}

        {sim && (
          <div className="sim-result" aria-live="polite">
            <p className="sim-label">Simulation, nothing has been saved</p>
            {(() => { const v = verdict(); return <p className={`verdict verdict-${v.tone}`}><RiskBadge risk={v.tone === 'details' ? null : v.tone} needsDetails={v.tone === 'details'} /> <span>{v.text}</span></p>; })()}

            <div className="table-wrap">
              <table className="table compare metrics-table">
                <caption>Before and after, from the scheduler</caption>
                <thead><tr><th>Measure</th><th>Now</th><th>After this change</th></tr></thead>
                <tbody>{metrics().map(([label, a, b]) => <tr key={label} className={String(a) !== String(b) ? 'is-changed' : ''}><th scope="row">{label}</th><td>{a}</td><td>{b}</td></tr>)}</tbody>
              </table>
            </div>

            <div className="sim-meaning">
              <h3>What this means</h3>
              <ul>{summary().map((t, i) => <li key={i}>{t}</li>)}</ul>
              <label className="sim-probe">Check whether another
                <select value={probe} onChange={(e) => { const v = Number(e.target.value); setProbe(v); runChange(sim.change, sim.source, v); }} aria-label="Duration of another order to test" disabled={busy}>
                  {PROBES.map((m) => <option key={m} value={m}>{formatMinutes(m)}</option>)}
                </select> order would fit
              </label>
            </div>

            <h3 className="sim-sub">Orders affected</h3>
            <div className="table-wrap">
              <table className="table compare">
                <caption className="sr-only">Orders affected by this scenario, before and after</caption>
                <thead><tr><th>Order</th><th>Before</th><th>After</th><th>Why</th></tr></thead>
                <tbody>
                  {view.rows.map((id) => (
                    <tr key={id}>
                      <th scope="row">{nameOf(id)}</th>
                      <td>{view.before[id] ? <><RiskBadge risk={view.before[id].risk} /><small>{formatInTz(view.before[id].scheduledEnd, tz)}</small></> : <span className="muted">New</span>}</td>
                      <td>{view.after[id] ? <><RiskBadge risk={view.after[id].risk} /><small>{formatInTz(view.after[id].scheduledEnd, tz)}</small></> : <span className="muted">-</span>}</td>
                      <td>{view.after[id]?.reason ?? '-'}</td>
                    </tr>
                  ))}
                  {view.rows.length === 0 && <tr><td colSpan="4" className="muted">No existing order is affected.</td></tr>}
                </tbody>
              </table>
            </div>

            {view.c.suggestedAdjustments?.length > 0 && (
              <div className="suggest">
                <h3>Suggested adjustments</h3>
                <ul>{view.c.suggestedAdjustments.map((s, i) => <li key={i}><b>{nameOf(s.orderId)}:</b> {s.explanation}</li>)}</ul>
              </div>
            )}

            <div className="form-actions">
              <button type="button" className="btn" onClick={discard} disabled={busy}>Discard scenario</button>
              {!confirming
                ? <button type="button" className="btn btn-primary" onClick={() => setConfirming(true)}>Apply this schedule…</button>
                : (
                  <>
                    <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={busy}>Not yet</button>
                    <button type="button" className="btn btn-primary" disabled={busy} onClick={apply}>{busy ? 'Saving…' : isAdd ? 'Yes, save it as a real order' : sim.change.order.prepTimeMinutes !== undefined ? 'Yes, save the new preparation time' : 'Yes, save the new deadline'}</button>
                  </>
                )}
            </div>
            {confirming && (
              <p className="notice sim-warn" role="status">
                {isAdd ? 'This creates a real order.'
                  : sim.change.order.prepTimeMinutes !== undefined ? `This changes the preparation time stored on ${nameOf(sim.change.orderId)}'s order. Apply it only if you really expect to prepare it that fast.`
                    : `This changes the promised deadline stored on ${nameOf(sim.change.orderId)}'s order. Apply it only once the customer has agreed.`} It uses the normal order API and affects only this one order.
              </p>
            )}
          </div>
        )}
      </div>
    </>
  );
}
