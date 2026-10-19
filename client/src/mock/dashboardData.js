// DEMO DATA ONLY — not from a backend. Dates are relative to "now" so the demo always looks current.
const HOUR = 60 * 60 * 1000;
const at = (hours) => new Date(Date.now() + hours * HOUR).toISOString();

export const mockDashboard = {
  stats: { total: 24, pending: 7, inProgress: 6, completed: 8, atRisk: 3 },
  workload: {
    pendingHours: 31,
    availableHours: 40,
    daily: [
      { label: 'Mon', hours: 6, capacity: 6 },
      { label: 'Tue', hours: 9, capacity: 6 },
      { label: 'Wed', hours: 4, capacity: 6 },
      { label: 'Thu', hours: 7, capacity: 6 },
      { label: 'Fri', hours: 3, capacity: 6 },
      { label: 'Sat', hours: 2, capacity: 5 },
      { label: 'Sun', hours: 0, capacity: 5 },
    ],
  },
  urgentOrders: [
    { id: 'ORD-1042', customer: 'Aanya Sharma', item: 'Custom birthday cake (2 kg)', deadline: at(5), prepHours: 4, status: 'Preparing', risk: 'high' },
    { id: 'ORD-1045', customer: 'Rohan Mehta', item: 'Gift hamper x3', deadline: at(20), prepHours: 5, status: 'Payment Received', risk: 'high' },
    { id: 'ORD-1039', customer: 'Priya Nair', item: 'Cupcake box (24)', deadline: at(30), prepHours: 3, status: 'Order Confirmed', risk: 'medium' },
  ],
  upcomingDeadlines: [
    { id: 'ORD-1042', customer: 'Aanya Sharma', deadline: at(5) },
    { id: 'ORD-1045', customer: 'Rohan Mehta', deadline: at(20) },
    { id: 'ORD-1039', customer: 'Priya Nair', deadline: at(30) },
    { id: 'ORD-1047', customer: 'Kabir Singh', deadline: at(52) },
    { id: 'ORD-1050', customer: 'Meera Iyer', deadline: at(76) },
  ],
  recommendations: [
    { id: 'r1', priority: 'high', action: 'Start ORD-1042 now', reason: 'Needs 4h of prep and is due in 5h — no buffer left.' },
    { id: 'r2', priority: 'high', action: 'Move ORD-1039 prep to Wednesday', reason: 'Tuesday is 3h over capacity; Wednesday has 2h free.' },
    { id: 'r3', priority: 'medium', action: 'Confirm payment for ORD-1047', reason: 'Payment is pending and the deadline is within 3 days.' },
  ],
};
