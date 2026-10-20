import { getDashboard, getPlanner, listOrders } from '../services/api.js';
import useAsync from './useAsync.js';

// One load of everything the overview/operations sections need. All numbers come from the backend;
// scheduling and risk are never recomputed on the client.
export default function useWorkspace() {
  return useAsync(async () => {
    const [dashboard, planner, orders] = await Promise.all([getDashboard(), getPlanner({ days: 14 }), listOrders({ pageSize: 100 })]);
    return { dashboard, planner, orders: orders.items };
  });
}
