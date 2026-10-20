import { useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { getPlanner, listOrders, simulatePlanner, createOrder, updateOrder } from '../services/api.js';
import useAsync from '../hooks/useAsync.js';
import { formatMinutes, formatDate, formatDateTime, toLocalInput, fromLocalInput } from '../utils/format.js';
import PageHeader from '../components/PageHeader.jsx';
import Panel from '../components/Panel.jsx';
import StateMessage from '../components/StateMessage.jsx';
import { RiskBadge } from '../components/Badge.jsx';
import '../css/Calendar.css';

const UNSCHEDULED_TEXT = { missing_prep_time: 'No prep time', missing_deadline: 'No deadline', missing_both: 'No prep time or deadline' };

export function DayGrid({ planner, riskById }) {
  return (
    <div className="day-grid">
      {planner.days.map((d) => {
        const pct = d.capacityMinutes ? Math.round((d.plannedMinutes / d.capacityMinutes) * 100) : 0;
        const state = d.capacityMinutes === 0 ? 'closed' : pct >= 100 ? 'full' : pct >= 85 ? 'busy' : 'ok';
        return (
          <div key={d.date} className={`day day-${state}`}>
            <div className="day-head">
              <strong>{formatDate(d.date)}</strong>
              <span className={`day-state state-${state}`}>{state === 'closed' ? 'Day off' : state === 'full' ? 'Fully booked' : state === 'busy' ? 'Busy' : 'Open'}</span>
            </div>
            <div className="meter"><div className={state === 'full' ? 'meter-fill over' : 'meter-fill'} style={{ width: `${Math.min(pct, 100)}%` }} /></div>
            <small className="muted">{formatMinutes(d.plannedMinutes)} / {formatMinutes(d.capacityMinutes)}</small>
            <ul>
              {d.orders.map((o) => (
                <li key={o.id} className={`day-order risk-edge-${riskById[o.id] ?? 'none'}`}>
                  <span>{o.customerName}</span><small>{o.item} · {formatMinutes(o.scheduledMinutes)}</small>
                </li>
              ))}
              {d.orders.length === 0 && d.capacityMinutes > 0 && <li className="muted"><small>Nothing scheduled</small></li>}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function Simulator({ openOrders, days, onApplied }) {
  const [mode, setMode] = useState('add');
  const [form, setForm] = useState({ customerName: '', item: '', prep: '', deadline: '', orderId: '' });
  const [sim, setSim] = useState(null); // { change, result }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [applied, setApplied] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  function buildChange() {
    if (mode === 'add') {
      const order = {
        customerName: form.customerName.trim(), item: form.item.trim(), quantity: 1,
        prepTimeMinutes: form.prep === '' ? null : Number(form.prep), deadline: fromLocalInput(form.deadline), source: 'manual',
      };
      return { type: 'add_order', order };
    }
    return { type: 'update_order', orderId: form.orderId, order: { deadline: fromLocalInput(form.deadline) } };
  }

  const ready = mode === 'add' ? form.customerName.trim() && form.item.trim() && form.prep !== '' && form.deadline : form.orderId && form.deadline;

  async function run(e) {
    e.preventDefault();
    setBusy(true); setError(null); setSim(null); setConfirming(false); setApplied(null);
    const change = buildChange();
    try {
      setSim({ change, result: await simulatePlanner({ changes: [change], days }) });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true); setError(null);
    try {
      const { change } = sim;
      if (change.type === 'add_order') await createOrder(change.order);
      else await updateOrder(change.orderId, change.order);
      setApplied('The change was saved to your orders.');
      setSim(null); setConfirming(false);
      onApplied();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const label = { change_0: 'Proposed order', ...Object.fromEntries(openOrders.map((o) => [o.id, `${o.customerName} — ${o.item}`])) };
  const riskById = sim ? Object.fromEntries(sim.result.planner.risks.map((r) => [r.orderId, r.risk])) : {};

  return (
    <Panel title="What-if simulation" subtitle="Preview the effect of a change. Nothing is saved until you apply it.">
      <form className="sim-form" onSubmit={run}>
        <div className="seg" role="radiogroup" aria-label="Simulation type">
          <button type="button" role="radio" aria-checked={mode === 'add'} className={mode === 'add' ? 'is-on' : ''} onClick={() => { setMode('add'); setSim(null); }}>Add an order</button>
          <button type="button" role="radio" aria-checked={mode === 'change'} className={mode === 'change' ? 'is-on' : ''} onClick={() => { setMode('change'); setSim(null); }}>Change a deadline</button>
        </div>
        <div className="form-grid">
          {mode === 'add' ? (
            <>
              <label className="field"><span className="field-label">Customer *</span><input value={form.customerName} onChange={set('customerName')} /></label>
              <label className="field"><span className="field-label">Item *</span><input value={form.item} onChange={set('item')} /></label>
              <label className="field"><span className="field-label">Prep time (minutes) *</span><input type="number" min="0" value={form.prep} onChange={set('prep')} /></label>
            </>
          ) : (
            <label className="field"><span className="field-label">Order *</span>
              <select value={form.orderId} onChange={(e) => { const o = openOrders.find((x) => x.id === e.target.value); setForm((f) => ({ ...f, orderId: e.target.value, deadline: toLocalInput(o?.deadline) })); }}>
                <option value="">Select an order…</option>
                {openOrders.map((o) => <option key={o.id} value={o.id}>{o.customerName} — {o.item}</option>)}
              </select>
            </label>
          )}
          <label className="field"><span className="field-label">{mode === 'add' ? 'Deadline *' : 'New deadline *'}</span><input type="datetime-local" value={form.deadline} onChange={set('deadline')} /></label>
        </div>
        <div className="form-actions"><button type="submit" className="btn btn-primary" disabled={!ready || busy}><FlaskConical size={15} /> {busy && !sim ? 'Simulating…' : 'Run simulation'}</button></div>
      </form>

      {error && <div className="notice error" role="alert">{error.message}{error.details?.map((d, i) => <div key={i}>{d.field}: {d.message}</div>)}</div>}
      {applied && <div className="notice ok" role="status">{applied}</div>}

      {sim && (
        <div className="sim-result">
          <div className="notice">Simulation only — your real schedule has not changed.</div>
          <ul className="sim-summary">
            <li>Pending workload: <strong>{sim.result.comparison.pendingMinutesDelta >= 0 ? '+' : '−'}{formatMinutes(Math.abs(sim.result.comparison.pendingMinutesDelta))}</strong></li>
            <li>New / worsened risks: <strong>{sim.result.comparison.newRisks.length}</strong></li>
            <li>Resolved risks: <strong>{sim.result.comparison.resolvedRisks.length}</strong></li>
            <li>Utilisation after change: <strong>{sim.result.planner.workload.utilisationPercent}%</strong></li>
          </ul>
          {sim.result.comparison.newRisks.map((r) => (
            <p key={r.orderId} className="sim-risk"><RiskBadge risk={r.risk} /> <strong>{label[r.orderId] ?? r.orderId}</strong> — {r.reason}</p>
          ))}
          {sim.result.comparison.resolvedRisks.map((r) => <p key={r.orderId} className="sim-risk"><span className="badge risk-low">Resolved</span> <strong>{label[r.orderId] ?? r.orderId}</strong></p>)}
          {sim.result.planner.recommendations.length > 0 && (
            <>
              <h3>Recommendations after this change</h3>
              <ul className="plain-list">{sim.result.planner.recommendations.map((r) => <li key={r.id} className={`reco reco-${r.priority}`}><span className="pill">{r.priority}</span><div><strong>{r.action}</strong><p>{r.reason}</p></div></li>)}</ul>
            </>
          )}
          <h3>Simulated schedule</h3>
          <DayGrid planner={sim.result.planner} riskById={riskById} />
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => { setSim(null); setConfirming(false); }}>Discard</button>
            {!confirming
              ? <button type="button" className="btn btn-primary" onClick={() => setConfirming(true)}>Apply this change…</button>
              : <button type="button" className="btn btn-primary" disabled={busy} onClick={apply}>{busy ? 'Saving…' : `Confirm: ${sim.change.type === 'add_order' ? 'create this order' : 'update the deadline'}`}</button>}
          </div>
        </div>
      )}
    </Panel>
  );
}

export default function Calendar() {
  const [days, setDays] = useState(7);
  const { status, data, error, reload } = useAsync(async () => {
    const [planner, orders] = await Promise.all([getPlanner({ days }), listOrders({ status: 'pending,confirmed,in_progress', pageSize: 100 })]);
    return { planner, orders: orders.items };
  }, [days]);

  const header = (
    <PageHeader title="Calendar" subtitle="Scheduled preparation, capacity and deadline risk.">
      <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Range"><option value={7}>Next 7 days</option><option value={14}>Next 14 days</option></select>
    </PageHeader>
  );
  if (status === 'loading' && !data) return <section className="page calendar">{header}<StateMessage kind="loading" message="Loading schedule…" /></section>;
  if (status === 'error') return <section className="page calendar">{header}<StateMessage kind="error" message={`Couldn't load the schedule. ${error.message}`} onRetry={reload} /></section>;

  const { planner, orders } = data;
  const byId = Object.fromEntries(orders.map((o) => [o.id, o]));
  const riskById = Object.fromEntries(planner.risks.map((r) => [r.orderId, r.risk]));
  const w = planner.workload;

  return (
    <section className="page calendar">
      {header}
      <Panel title="Capacity" subtitle={`Pending preparation vs. working hours for the next ${days} days`}>
        <p className="workload-figure"><strong>{formatMinutes(w.pendingMinutes)}</strong> of {formatMinutes(w.availableMinutes)} <span className="muted">({w.utilisationPercent}%)</span></p>
        <div className="meter"><div className={w.utilisationPercent > 100 ? 'meter-fill over' : 'meter-fill'} style={{ width: `${Math.min(w.utilisationPercent, 100)}%` }} /></div>
        {orders.length === 0 ? <StateMessage message="No open orders to schedule." /> : <DayGrid planner={planner} riskById={riskById} />}
      </Panel>

      <div className="grid-2 cal-lower">
        <Panel title="Deadline risks" subtitle="Orders that may be delayed">
          {planner.risks.length === 0 ? <StateMessage message="No deadline risks right now." /> : (
            <ul className="plain-list">{planner.risks.map((r) => (
              <li key={r.orderId} className="risk-row"><RiskBadge risk={r.risk} /><div><strong>{byId[r.orderId]?.customerName ?? r.orderId}</strong> <span className="muted">{byId[r.orderId]?.item}</span><p className="muted">{r.reason} {byId[r.orderId]?.deadline && `Due ${formatDateTime(byId[r.orderId].deadline)}.`}</p></div></li>
            ))}</ul>
          )}
        </Panel>
        <Panel title="Not scheduled" subtitle="Left out of capacity planning until details are added">
          {planner.unscheduledOrders.length === 0 ? <StateMessage message="Every open order has a prep time and deadline." /> : (
            <ul className="plain-list">{planner.unscheduledOrders.map((u) => (
              <li key={u.id}><strong>{byId[u.id]?.customerName ?? u.id}</strong> <span className="muted">{byId[u.id]?.item}</span><p className="muted">{UNSCHEDULED_TEXT[u.reason] ?? u.reason}</p></li>
            ))}</ul>
          )}
        </Panel>
      </div>

      <Simulator openOrders={orders} days={days} onApplied={reload} />
    </section>
  );
}
