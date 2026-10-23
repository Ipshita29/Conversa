// Central API client. Endpoints and shapes follow docs/api-contract.md (Draft).
// Demo mode (VITE_DEMO_MODE, default on) routes every call to the in-memory mock backend in src/mock/.
// A failed live request is ALWAYS thrown as an ApiError — it is never replaced with mock data.
export const DEMO_MODE = import.meta.env.VITE_DEMO_MODE !== 'false';
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details || [];
  }
}

async function request(method, path, body) {
  if (DEMO_MODE) {
    const { handleMockRequest } = await import('../mock/mockApi.js');
    return handleMockRequest(method, path, body);
  }

  let res;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', `Cannot reach the server at ${API_BASE_URL}. Is the backend running?`);
  }

  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }

  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code || 'HTTP_ERROR', e?.message || `Request failed (${res.status})`, e?.details);
  }
  if (data === null) throw new ApiError(res.status, 'INVALID_RESPONSE', 'The server returned an unreadable response.');
  return data;
}

const qs = (params = {}) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
  return s ? `?${s}` : '';
};

export const getDashboard = () => request('GET', '/dashboard');
export const getMonthlyAnalytics = (month, dataset) => request('GET', `/analytics/monthly${qs({ month, dataset })}`);

export const listOrders = (params) => request('GET', `/orders${qs(params)}`);
export const createOrder = (order) => request('POST', '/orders', order);
export const getOrder = (id) => request('GET', `/orders/${encodeURIComponent(id)}`);
export const updateOrder = (id, patch) => request('PATCH', `/orders/${encodeURIComponent(id)}`, patch);

export const extractOrder = (payload) => request('POST', '/ai/extract-order', payload);

export const getPlanner = (params) => request('GET', `/planner${qs(params)}`);
export const simulatePlanner = (payload) => request('POST', '/planner/simulate', payload);

export const getIntegrations = () => request('GET', '/integrations');
export const connectIntegration = (channel) => request('POST', `/integrations/${channel}/connect`, {});

// Not in docs/api-contract.md yet (proposed addition, implemented in server/README.md): conversations stored from
// Meta webhooks. Demo mode returns clearly-labelled sample conversations.
export const getConversations = () => request('GET', '/conversations');
// patch: { read: true } and/or { orderId: string | null }
export const updateConversation = (id, patch) => request('PATCH', `/conversations/${encodeURIComponent(id)}`, patch);
