import { computePlan, normalizeOrder } from './workloadEngine.js';
import { OPEN_STATUSES } from '../utils/validation.js';

// Built from the SAME computePlan() as the planner, so dashboard and planner numbers always agree.
export function buildDashboard(orders, settings, now = new Date()) {
  const plan = computePlan({ orders, settings, now, rangeDays: 7 });
  const norm = orders.map(normalizeOrder);
  const open = norm.filter((o) => OPEN_STATUSES.includes(o.status));
  const riskOf = (id) => plan.results[id]?.risk ?? null;
  const withDeadline = open.filter((o) => o.deadline).sort((a, b) => a.deadline - b.deadline);

  const urgent = withDeadline
    .filter((o) => ['high', 'medium'].includes(riskOf(o.id)) || o.deadline.getTime() - now.getTime() < 48 * 3600000)
    .slice(0, 5)
    .map((o) => ({ id: o.id, customerName: o.customerName, item: o.item, deadline: o.deadline.toISOString(), prepTimeMinutes: o.prepTimeMinutes, status: o.status, risk: riskOf(o.id) }));

  return {
    stats: {
      total: norm.length,
      pending: norm.filter((o) => o.status === 'pending' || o.status === 'confirmed').length,
      inProgress: norm.filter((o) => o.status === 'in_progress').length,
      completed: norm.filter((o) => o.status === 'completed').length,
      atRisk: open.filter((o) => ['high', 'medium'].includes(riskOf(o.id))).length,
    },
    workload: {
      pendingMinutes: plan.workload.pendingMinutes,
      pendingHours: plan.workload.pendingHours,
      availableMinutes: plan.workload.availableMinutes,
      availableHours: plan.workload.availableHours,
      daily: plan.days.map(({ date, plannedMinutes, capacityMinutes }) => ({ date, plannedMinutes, capacityMinutes })),
    },
    urgentOrders: urgent,
    upcomingDeadlines: withDeadline.slice(0, 5).map((o) => ({ id: o.id, customerName: o.customerName, deadline: o.deadline.toISOString() })),
    recommendations: plan.recommendations,
  };
}
