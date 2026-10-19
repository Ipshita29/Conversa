import { mockDashboard } from '../mock/dashboardData.js';

// Demo mode is explicit: set VITE_USE_MOCK=false to call the real API.
// API failures are never converted into mock successes.
// ASSUMPTION: docs/api-contract.md does not exist yet; GET /api/dashboard is expected
// to return the same shape as mockDashboard. Update here once the contract is published.
export const USE_MOCK = import.meta.env.VITE_USE_MOCK !== 'false';

export async function getDashboard() {
  if (USE_MOCK) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return { data: mockDashboard, isDemo: true };
  }
  const res = await fetch('/api/dashboard');
  if (!res.ok) throw new Error(`Dashboard request failed (${res.status})`);
  return { data: await res.json(), isDemo: false };
}
