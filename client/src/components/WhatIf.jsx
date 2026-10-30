import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { ArrowRight, CalendarClock, Check, FlaskConical, RotateCcw, Timer, Zap } from 'lucide-react';
import { simulatePlanner, createOrder, updateOrder } from '../services/api.js';
import { formatInTz, formatMinutes, toLocalInput, fromLocalInput, OPEN } from '../utils/format.js';
import { findExperiments } from '../utils/experiments.js';
import { buildComparison, statusOf } from '../utils/scheduleDiff.js';
import { DemoBadge } from './UI.jsx';
import '../css/WhatIfPage.css';

// The Three.js stage loads on demand; the page (and every result) works without it.
const DeadlineStage = lazy(() => import('./DeadlineStage.jsx'));

const SCENARIOS = [
  { key: 'deadline', title: 'Fix a deadline', blurb: 'Move an overdue order to a deadline you can keep.', exp: 'deadline', Icon: CalendarClock },
  { key: 'prep', title: 'Reduce prep time', blurb: 'See whether faster preparation improves delivery.', exp: 'prep', Icon: Timer },
  { key: 'rush', title: 'Add a rush order', blurb: 'Check whether an urgent order fits the schedule.', exp: 'rush', Icon: Zap },
];
const EMPTY = { deadline: { orderId: '', deadline: '' }, prep: { orderId: '', prep: '' }, rush: { customerName: 'New customer', item: 'Rush order', prep: '60', deadline: '' } };
const TONE = { late: 'late', warn: 'warn', ok: 'ok', done: 'ok', resolved: 'resolved' };
// The label a business owner reads: On track / At risk / Overdue (or Still late when a change does not fix it).
const planLabel = (st) => (st.tone === 'resolved' || st.tone === 'ok' ? 'On track' : st.tone === 'warn' ? 'At risk' : st.tone === 'done' ? st.label : st.label);

function schedStatus(o, planner) {
  const e = planner.schedule?.find((x) => x.orderId === o.id);
  return e ? statusOf(e, o) : { label: o.status === 'completed' ? 'Completed' : o.status === 'cancelled' ? 'Cancelled' : 'No schedule', tone: 'done' };
}

// The whole What-if experience. A run is POST /planner/simulate, which works on a copy on the server: nothing is saved until the owner
// presses Apply and confirms, and then the normal order endpoints are used. Every date, status and sentence below comes from the
// scheduler's two answers (the schedule today and the simulated one) for the same moment.
export function WhatIfWorkspace({ planner, orders, onApplied, prefill }) {
  const tz = planner.range.timezone;
  const days = planner.range.days;
  const byId = useMemo(() => Object.fromEntries(orders.map((o) => [o.id, o])), [orders]);
  const openOrders = useMemo(() => orders.filter((o) => OPEN.includes(o.status)).sort((a, b) => (schedStatus(a, planner).tone === 'late' ? 0 : 1) - (schedStatus(b, planner).tone === 'late' ? 0 : 1)), [orders, planner]);
  const T = (iso) => (iso ? formatInTz(iso, tz) : '—');

  const [exps, setExps] = useState(null);       // the scheduler-checked proposal for each scenario (null while pre-checking)
  const [scen, setScen] = useState('deadline');
  const [drafts, setDrafts] = useState(EMPTY);
  const [sim, setSim] = useState(null);         // { change, result, key }
  const [runKey, setRunKey] = useState(0);      // bumps on every run so the stage replays the transformation
  const [view, setView] = useState('sim');      // 'orig' | 'sim'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(null);

  const draftsFrom = (m, d) => ({
    deadline: m.deadline?.change ? { orderId: m.deadline.change.orderId, deadline: toLocalInput(m.deadline.change.order.deadline) } : d.deadline,
    prep: m.prep?.change ? { orderId: m.prep.change.orderId, prep: String(m.prep.change.order.prepTimeMinutes) } : d.prep,
    rush: m.rush?.change ? { customerName: m.rush.change.order.customerName, item: m.rush.change.order.item, prep: String(m.rush.change.order.prepTimeMinutes), deadline: toLocalInput(m.rush.change.order.deadline) } : d.rush,
  });

  // Proposals come from the scheduler (utils/experiments.js); they are only starting values, and every field stays editable.
  useEffect(() => {
    let live = true;
    setExps(null);
    findExperiments({ planner, orders, simulate: simulatePlanner, days })
      .then((list) => { if (!live) return; const m = Object.fromEntries(list.map((x) => [x.type, x])); setExps(m); setDrafts((d) => draftsFrom(m, d)); })
      .catch(() => { if (live) setExps({}); });
    return () => { live = false; };
  }, [planner, orders, days]);

  // "Simulate" buttons on the Risks page arrive here with an order and a deadline to try. Nothing runs or saves.
  useEffect(() => {
    if (!prefill) return;
    setScen('deadline'); setSim(null); setError(null); setDone(null); setConfirming(false);
    setDrafts((d) => ({ ...d, deadline: { orderId: prefill.orderId, deadline: toLocalInput(prefill.deadline) } }));
  }, [prefill?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const d = drafts[scen];
  const setField = (k) => (e) => setDrafts((x) => ({ ...x, [scen]: { ...x[scen], [k]: e.target.value } }));
  const pickOrder = (e) => {
    const o = byId[e.target.value];
    setDrafts((x) => ({ ...x, [scen]: scen === 'deadline' ? { orderId: e.target.value, deadline: toLocalInput(o?.deadline) } : { orderId: e.target.value, prep: o?.prepTimeMinutes ?? '' } }));
  };
  const valid = scen === 'deadline' ? d.orderId && d.deadline
    : scen === 'prep' ? d.orderId && d.prep !== '' && Number(d.prep) >= 0
      : d.customerName.trim() && d.item.trim() && d.prep !== '' && Number(d.prep) > 0 && d.deadline;
  const buildChange = () => (scen === 'deadline' ? { type: 'update_order', orderId: d.orderId, order: { deadline: fromLocalInput(d.deadline) } }
    : scen === 'prep' ? { type: 'update_order', orderId: d.orderId, order: { prepTimeMinutes: Number(d.prep) } }
      : { type: 'add_order', order: { customerName: d.customerName.trim(), item: d.item.trim(), quantity: 1, prepTimeMinutes: Number(d.prep), deadline: fromLocalInput(d.deadline), source: 'manual' } });
  const key = JSON.stringify([scen, d]);

  async function run() {
    setBusy(true); setError(null); setConfirming(false); setDone(null);
    const change = buildChange();
    try { const result = await simulatePlanner({ changes: [change], days, probeMinutes: 60 }); setSim({ change, key, result }); setRunKey((n) => n + 1); setView('sim'); }
    catch (e) { setSim(null); setError(e); }
    finally { setBusy(false); }
  }
  // Reset: back to the original scenario. Nothing was ever saved, so nothing needs undoing.
  function reset() { setSim(null); setError(null); setConfirming(false); setDone(null); setView('orig'); setDrafts(exps ? (x) => draftsFrom(exps, EMPTY) : EMPTY); setRunKey((n) => n + 1); }
  async function apply() {
    setBusy(true); setError(null);
    try {
      if (sim.change.type === 'add_order') await createOrder(sim.change.order); else await updateOrder(sim.change.orderId, sim.change.order);
      setDone('Applied and saved. The schedule now reflects the change.'); setSim(null); setConfirming(false); setView('orig'); onApplied?.();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  const cmp = useMemo(() => {
    if (!sim) return null;
    const base = sim.result.baseline ?? { schedule: planner.schedule ?? [], unscheduledOrders: planner.unscheduledOrders ?? [] };
    return buildComparison({ orders, baseline: base, after: sim.result.planner, change: sim.change, byId, tz });
  }, [sim, orders, byId, tz]); // eslint-disable-line react-hooks/exhaustive-deps
  const stale = Boolean(sim && sim.key !== key);
  const showSim = Boolean(cmp) && view === 'sim';
  const target = cmp?.rows.find((r) => r.target) ?? null;
  const story = cmp?.story;
  const s = cmp?.summary;
  const cur = byId[d.orderId];

  // ---- what the stage shows: the real schedule today, a ghost of the proposal, and (after a run) the scheduler's result
  const entryOf = (id) => planner.schedule?.find((e) => e.orderId === id);
  const stageView = useMemo(() => {
    const o = scen !== 'rush' && cur ? { deadline: cur.deadline, finish: entryOf(cur.id)?.scheduledEnd ?? null, tone: TONE[schedStatus(cur, planner).tone] ?? 'ok' } : null;
    const draft = scen === 'deadline' || scen === 'rush' ? (d.deadline ? fromLocalInput(d.deadline) : null) : null;
    const simView = target?.sim ? { deadline: target.sim.deadline, finish: target.sim.finish, tone: TONE[target.sim.status.tone] ?? 'ok' } : null;
    return { now: planner.generatedAt, orig: o, draft: simView ? null : draft, sim: showSim ? simView : null, runKey };
  }, [scen, cur, d.deadline, target, showSim, runKey, planner]); // eslint-disable-line react-hooks/exhaustive-deps
  const stageLabel = showSim && target?.sim
    ? `Original deadline ${T(target.orig.deadline)}, ${planLabel(target.orig.status)}. After the change: deadline ${T(target.sim.deadline)}, predicted finish ${T(target.sim.finish)}, ${planLabel(target.sim.status)}.`
    : cur ? `Current deadline ${T(cur.deadline)}, predicted finish ${T(entryOf(cur.id)?.scheduledEnd)}, ${planLabel(schedStatus(cur, planner))}.` : 'Choose an order to see its deadline on the timeline.';

  const subOf = (sc) => {
    const x = exps?.[sc.exp];
    if (!exps) return 'Checking…';
    if (sc.key === 'rush') return x?.change ? '1-hour job' : 'No free hour';
    const o = x?.change?.orderId ? byId[x.change.orderId] : null;
    if (!o) return 'No safe option';
    return sc.key === 'deadline' ? `${o.customerName} · ${planLabel(schedStatus(o, planner))}` : o.customerName;
  };
  const unavailable = exps?.[SCENARIOS.find((x) => x.key === scen).exp]?.unavailable;
  const prepText = (v) => (v == null ? 'Not set' : formatMinutes(v));

  // The impact sentence. It appears only when the scheduler's result supports it.
  const statement = (() => {
    if (!cmp || !story) return null;
    const h = story.headline;
    const fixed = scen === 'deadline' && target && target.orig.status.tone === 'late' && ['resolved', 'ok'].includes(target.sim?.status.tone) && s.worse.length === 0;
    const tone = fixed ? 'good' : h.tone === 'low' ? 'good' : h.tone === 'medium' ? 'warn' : 'bad';
    return { tone, title: fixed ? 'This works' : h.title, text: fixed ? 'Moving the deadline gives this order enough time to finish without delaying other commitments.' : h.text, alt: h.alternative };
  })();

  const rows = showSim ? cmp.rows : orders.map((o) => ({ id: o.id, name: o.customerName, item: o.item, quantity: o.quantity, orig: { deadline: o.deadline, prep: o.prepTimeMinutes, finish: entryOf(o.id)?.scheduledEnd ?? null, status: schedStatus(o, planner) }, sim: null }));
  const stagePending = scen !== 'rush' && !cur;

  return (
    <div className="wf">
      <header className="wf-head">
        <div>
          <p className="wf-eyebrow">What-if simulator</p>
          <h1>Move a deadline, <em>see what happens.</em></h1>
          <p className="wf-sub">Test a change on a copy of your schedule. Nothing is saved until you apply it.</p>
        </div>
        <DemoBadge />
      </header>

      <section className="wf-scn" role="radiogroup" aria-label="Scenario">
        {SCENARIOS.map(({ key: k, title, blurb, Icon, exp }) => (
          <button key={k} type="button" role="radio" aria-checked={scen === k} className={`wf-card${scen === k ? ' is-on' : ''}`} onClick={() => { setScen(k); setSim(null); setError(null); setConfirming(false); setView('orig'); setRunKey((n) => n + 1); }}>
            <span className="wf-ico"><Icon size={20} aria-hidden="true" /></span>
            <strong>{title}</strong>
            <small>{blurb}</small>
            <em className="wf-chip">{subOf({ key: k, exp })}</em>
            <i className="wf-check" aria-hidden="true"><Check size={14} /></i>
          </button>
        ))}
      </section>

      <section className="wf-lab" aria-label="Simulation">
        <div className="wf-controls">
          {unavailable && <p className="wf-hint">No safe suggestion found. Enter your own values.</p>}
          {scen !== 'rush' ? (
            <>
              <label className="field wf-order"><span className="field-label">Order</span>
                <select value={d.orderId} onChange={pickOrder}><option value="">Select an order…</option>{openOrders.map((o) => <option key={o.id} value={o.id}>{o.customerName} · {o.item}</option>)}</select>
              </label>
              <div className="wf-pair">
                <div className="wf-from"><span className="field-label">Current</span><b>{!cur ? '—' : scen === 'deadline' ? T(cur.deadline) : prepText(cur.prepTimeMinutes)}</b></div>
                <ArrowRight size={16} className="wf-to" aria-hidden="true" />
                {scen === 'deadline'
                  ? <label className="field wf-into"><span className="field-label">Proposed deadline</span><input type="datetime-local" value={d.deadline} onChange={setField('deadline')} /></label>
                  : <label className="field wf-into"><span className="field-label">Proposed prep (minutes)</span><input type="number" min="0" step="5" value={d.prep} onChange={setField('prep')} /></label>}
              </div>
            </>
          ) : (
            <div className="wf-rush">
              <label className="field"><span className="field-label">Customer</span><input value={d.customerName} onChange={setField('customerName')} /></label>
              <label className="field"><span className="field-label">Item</span><input value={d.item} onChange={setField('item')} /></label>
              <label className="field"><span className="field-label">Prep (minutes)</span><input type="number" min="5" step="5" value={d.prep} onChange={setField('prep')} /></label>
              <label className="field"><span className="field-label">Deadline</span><input type="datetime-local" value={d.deadline} onChange={setField('deadline')} /></label>
            </div>
          )}
        </div>

        <div className={`wf-stage${busy ? ' is-busy' : ''}${stagePending ? ' is-empty' : ''}`} aria-busy={busy}>
          {!stagePending && (
            <Suspense fallback={<div className="ds ds-fallback" />}>
              <DeadlineStage view={stageView} tz={tz} fmt={T} ariaLabel={stageLabel} />
            </Suspense>
          )}
          {stagePending && <p className="wf-stage-empty">Choose an order to see its deadline on the timeline.</p>}
          {!stagePending && <ul className="wf-key" aria-hidden="true"><li><i className="k-late" />Late</li><li><i className="k-warn" />Tight</li><li><i className="k-ok" />On track</li></ul>}
        </div>

        <div className="wf-runbar">
          <button type="button" className="btn btn-primary wf-run" disabled={!valid || busy || !exps} onClick={run}><FlaskConical size={16} aria-hidden="true" />{busy ? 'Simulating…' : sim ? 'Run again' : 'Run simulation'}</button>
          <button type="button" className="btn wf-reset" onClick={reset} disabled={busy || (!sim && !error)}><RotateCcw size={15} aria-hidden="true" /> Reset</button>
          <p className="wf-temp">{sim ? 'Temporary: nothing has been saved.' : 'Results are temporary until you apply them.'}</p>
        </div>
        {stale && <p className="wf-stale" role="status">Inputs changed. Run the simulation again to update.</p>}
      </section>

      {error && <div className="notice error" role="alert">Couldn't run the simulation: {error.message}{error.details?.map((x, i) => <div key={i}>{x.field}: {x.message}</div>)}</div>}
      {done && <div className="notice ok" role="status">{done}</div>}

      {cmp && target && (
        <section className="wf-result" aria-live="polite" aria-label="Result">
          <div className="wf-plans">
            <article className="wf-plan is-orig">
              <header><span>Original plan</span></header>
              <dl>
                {story.compare.map((c) => <div key={c.label}><dt>{c.label}</dt><dd>{c.original}</dd></div>)}
                <div><dt>Status</dt><dd><span className={`wf-pill t-${target.orig.status.tone}`}>{cmp.isNew ? 'Proposed' : planLabel(target.orig.status)}</span></dd></div>
              </dl>
            </article>
            <span className="wf-arrow" aria-hidden="true"><ArrowRight size={20} /></span>
            <article className={`wf-plan is-new t-${target.sim ? TONE[target.sim.status.tone] ?? 'ok' : 'late'}`}>
              <header><span>Proposed plan</span><em>Not saved</em></header>
              <dl>
                {story.compare.map((c) => <div key={c.label}><dt>{c.label}</dt><dd>{c.proposed}</dd></div>)}
                <div><dt>Status</dt><dd><span className={`wf-pill t-${target.sim?.status.tone ?? 'late'}`}>{target.sim ? planLabel(target.sim.status) : "Can't be scheduled"}</span></dd></div>
              </dl>
            </article>
          </div>

          {statement && (
            <div className={`wf-say is-${statement.tone}`}>
              <strong>{statement.title}</strong>
              <p>{statement.text}</p>
              {statement.alt && <p className="wf-alt">{statement.alt}</p>}
            </div>
          )}

          <ul className="wf-metrics" aria-label="Impact">
            <li><span>Orders changed</span><b>{s.changed} of {s.total}</b></li>
            <li><span>Deadlines at risk</span><b>{s.beforeRisk} → {s.afterRisk}</b></li>
            <li><span>Schedule</span><b>{!s.passes ? 'Not feasible' : s.afterHigh === 0 ? 'Feasible' : `${s.afterHigh} still late`}</b></li>
          </ul>
        </section>
      )}

      <section className="wf-impact" aria-label="Schedule impact">
        <header className="wf-impact-head">
          <h2>Schedule impact</h2>
          <div className="wf-switch" role="tablist" aria-label="Schedule">
            <button type="button" role="tab" aria-selected={!showSim} className={!showSim ? 'is-on' : ''} onClick={() => setView('orig')}>Original schedule</button>
            <button type="button" role="tab" aria-selected={showSim} className={showSim ? 'is-on' : ''} disabled={!cmp} onClick={() => setView('sim')}>Simulated schedule</button>
          </div>
        </header>
        <ul className="wf-rows">
          {rows.map((r) => <ImpactRow key={r.id} r={r} sim={showSim} T={T} />)}
        </ul>
        {!cmp && <p className="wf-foot">Run a simulation to see which orders it changes.</p>}
        {cmp && showSim && <p className="wf-foot">{s.changed === 0 ? 'No order changes.' : `Highlighted: the ${s.changed} ${s.changed === 1 ? 'order' : 'orders'} this change touches. The rest are unaffected.`}</p>}
      </section>

      {cmp && (
        <div className="wf-apply">
          <p>{confirming ? (cmp.isNew ? 'This creates a real order.' : sim.change.order.prepTimeMinutes !== undefined ? `This changes the saved prep time on ${byId[sim.change.orderId]?.customerName}'s order.` : `This changes the saved deadline on ${byId[sim.change.orderId]?.customerName}'s order. Apply it once the customer agrees.`) : 'Happy with this result? Applying saves it to the real order.'}</p>
          <div>
            {!confirming
              ? <button type="button" className="btn btn-primary" disabled={stale || busy || story.headline.tone === 'details'} onClick={() => setConfirming(true)}>Apply changes</button>
              : (<><button type="button" className="btn" onClick={() => setConfirming(false)} disabled={busy}>Not yet</button>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={apply}>{busy ? 'Saving…' : cmp.isNew ? 'Save as a real order' : sim.change.order.prepTimeMinutes !== undefined ? 'Save new prep time' : 'Save new deadline'}</button></>)}
          </div>
        </div>
      )}
    </div>
  );
}

// One order in the schedule. In the simulated view a changed value reads "old → new", and only orders the change touches are highlighted.
function ImpactRow({ r, sim, T }) {
  const o = r.orig; const n = r.sim ?? r.orig;
  const changed = sim && r.changed;
  const status = sim ? n.status : o.status;
  const finishMoved = sim && !r.isNew && String(T(o.finish)) !== String(T(n.finish));
  const stMoved = sim && r.statusChanged && !r.isNew;
  const effect = !sim ? null : r.isNew ? 'New order' : r.target ? 'Changed order' : changed ? (r.dir === 'worse' ? 'Affected: closer to its deadline' : r.dir === 'better' ? 'Affected: more room' : 'Affected: finishes at a different time') : 'Not affected';
  return (
    <li className={`wf-row${changed ? ' is-changed' : ''}${sim && !changed ? ' is-quiet' : ''}${r.dir ? ` d-${r.dir}` : ''}${r.target && sim ? ' is-target' : ''}`}>
      <span className="wf-who"><strong>{r.name}</strong><small>{r.item}{r.quantity > 1 ? ` × ${r.quantity}` : ''}</small></span>
      <span className="wf-c"><small>Deadline</small>{sim && !r.isNew && String(T(o.deadline)) !== String(T(n.deadline)) ? <><s>{T(o.deadline)}</s> <b>{T(n.deadline)}</b></> : T(n.deadline)}</span>
      <span className="wf-c"><small>Predicted finish</small>{finishMoved ? <><s>{T(o.finish)}</s> <b>{T(n.finish)}</b></> : T(n.finish)}</span>
      <span className="wf-c wf-st"><small>Status</small><span className={`wf-pill t-${status.tone}`}>{stMoved ? <><s>{planLabel(o.status)}</s> → {planLabel(n.status)}</> : planLabel(status)}</span></span>
      {sim && <span className={`wf-fx${changed ? ' is-on' : ''}`}>{effect}</span>}
    </li>
  );
}
