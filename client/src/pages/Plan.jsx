import { useMemo } from 'react';
import useAsync from '../hooks/useAsync.js';
import { getBoard, getPlanner, listOrders, DEMO_MODE } from '../services/api.js';
import useDataset from '../hooks/useDataset.js';
import DatasetToggle from '../components/DatasetToggle.jsx';
import { DemoBadge, StateMessage } from '../components/UI.jsx';
import ProductionStory from '../components/ProductionStory.jsx';
import { buildDay } from '../utils/roadmap.js';
import '../css/Workspace.css';

// The production roadmap, as one journey down the page. Every time on it comes from the scheduler (GET /api/planner): work is placed in the order
// the plan follows (deadlines), and what is left of each day is available capacity.
// Scrolling drives it: the line fills as you travel, each stop lights up as it arrives, and the day you are on is tracked in the summary.
// Nothing is hardcoded and nothing is saved by looking.
export default function Plan() {
  const ds = useDataset(); // the Plan shows one data set: demo orders never take capacity from real ones
  const { status, data, error, reload } = useAsync(async () => {
    if (!ds.ready) return new Promise(() => {});
    const [planner, board, orders] = await Promise.all([getPlanner({ days: 30, dataset: ds.dataset }), getBoard(ds.dataset ?? 'all'), listOrders({ pageSize: 100, dataset: ds.dataset })]);
    return { planner, board, orders: orders.items };
  }, [ds.dataset, ds.ready]);
  const planner = data?.planner;
  const tz = planner?.range.timezone;
  const days = planner?.days ?? [];
  const board = useMemo(() => (data ? [...data.board.sections.overdue, ...data.board.sections.onTrack, ...data.board.sections.upcoming] : []), [data]);
  // One chapter per day that has work in it; a calm day (today, with nothing booked) is still shown so the page is never empty.
  const chapters = useMemo(() => {
    if (!data) return [];
    const ctx = { schedule: planner.schedule, board, orders: data.orders };
    const busy = days.filter((d) => d.orders.length > 0);
    return (busy.length ? busy : days.slice(0, 1)).map((d) => ({ date: d.date, ...buildDay(d, ctx) }));
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const planned = chapters.flatMap((c) => c.rows.filter((r) => r.type === 'task'));
  // Demo: a miscellaneous rush order (not tied to a customer), made straight after the planned work.
  const last = planned[planned.length - 1];
  const rush = last && (DEMO_MODE || ds.dataset === 'demo') ? (() => { const start = new Date(last.end); const end = new Date(start.getTime() + 60 * 60000); return { ...last, id: 'misc-rush', key: 'misc-rush', mergeKey: 'misc-rush', customerName: 'Miscellaneous order', item: '4 chocolate pastries for rush order', quantity: 1, start: start.toISOString(), end: end.toISOString(), prep: 60, deadline: null, buffer: null, risk: 'low', more: false }; })() : null;
  const tasksAll = rush ? [...planned, rush] : planned;
  const head = (
    <header className="rm-head">
      <div className="rm-head-actions"><DatasetToggle ds={ds} /><DemoBadge /></div>
    </header>
  );

  if (!data && status === 'loading') return <section className="page plan roadmap">{head}<StateMessage kind="loading" message="Building your roadmap…" /></section>;
  if (status === 'error' || !data) return <section className="page plan roadmap">{head}<StateMessage kind="error" message={`Couldn't load the plan. ${error?.message ?? ''}`} onRetry={reload} /></section>;

  return (
    <section className={`page plan roadmap${status === 'loading' ? ' is-loading' : ''}`}>
      {head}

      <ProductionStory tasks={tasksAll} orders={data.orders} tz={tz} />
    </section>
  );
}
