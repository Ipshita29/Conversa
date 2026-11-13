import { badQuery } from './errors.js';

// Demo and real records live side by side in the database and are never mixed on a page. `dataset` is 'real', 'demo' or 'all' (the default, which keeps
// every existing call unchanged); the browser asks for one explicitly, and says which it is showing.
export const DATASETS = ['real', 'demo', 'all'];
export function datasetOf(raw) {
  if (raw === undefined || raw === '') return 'all';
  if (!DATASETS.includes(raw)) throw badQuery([{ field: 'dataset', message: 'Must be real, demo or all.' }]);
  return raw;
}
export const isDemoOrderDoc = (o) => typeof o?.notes === 'string' && o.notes.startsWith('[DEMO]');
export const orderFilter = (d) => (d === 'demo' ? { notes: /^\[DEMO\]/ } : d === 'real' ? { notes: { $not: /^\[DEMO\]/ } } : {});
export const keepDataset = (list, d, isDemo) => (d === 'all' ? list : list.filter((x) => (d === 'demo') === Boolean(isDemo(x))));
