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
export const getBoard = (dataset) => request('GET', `/board${qs({ dataset })}`);
export const getInsights = (range, dataset) => request('GET', `/analytics/summary${qs({ range, dataset })}`);
export const getMonthlyAnalytics = (month, dataset) => request('GET', `/analytics/monthly${qs({ month, dataset })}`);

export const listOrders = (params) => request('GET', `/orders${qs(params)}`);
export const createOrder = (order) => request('POST', '/orders', order);
export const getOrder = (id) => request('GET', `/orders/${encodeURIComponent(id)}`);
export const updateOrder = (id, patch) => request('PATCH', `/orders/${encodeURIComponent(id)}`, patch);

export const extractOrder = (payload) => request('POST', '/ai/extract-order', payload);

export const getPlanner = (params) => request('GET', `/planner${qs(params)}`);
export const simulatePlanner = (payload) => request('POST', '/planner/simulate', payload);

// Payments. Nothing here marks money as received on its own: records start as "pending" until the owner confirms them.
export const getPayments = () => request('GET', '/payments');
export const getPayment = (id) => request('GET', `/payments/${encodeURIComponent(id)}`);
export const confirmPayment = (id, body) => request('POST', `/payments/${encodeURIComponent(id)}/confirm`, body);
export const rejectPayment = (id, body) => request('POST', `/payments/${encodeURIComponent(id)}/reject`, body);
export const refundPayment = (id, body) => request('POST', `/payments/${encodeURIComponent(id)}/refund`, body);
export const extractPaymentText = (body) => request('POST', '/payments/extract', body);

// Image uploads are sent as the raw request body. In demo mode they stay in the browser, except `live` calls, which always go to the real server.
async function sendImage(method, path, file, { live = false } = {}) {
  if (DEMO_MODE && !live) { const { handleMockRequest } = await import('../mock/mockApi.js'); return handleMockRequest(method, path.replace(/\?.*$/, ''), { file, orderId: new URLSearchParams(path.split('?')[1] ?? '').get('orderId') }); }
  let res;
  try { res = await fetch(`${API_BASE_URL}${path}`, { method, headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name ?? '') }, body: file }); }
  catch { throw new ApiError(0, 'NETWORK_ERROR', `Cannot reach the server at ${API_BASE_URL}${live ? ', which reads the screenshot' : ''}. Is the backend running?`); }
  let data = null; try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) { const e = data?.error; throw new ApiError(res.status, e?.code || 'HTTP_ERROR', e?.message || `Request failed (${res.status})`, e?.details); }
  return data;
}
export async function recordPayment(payment, file) {
  const rec = await request('POST', '/payments', DEMO_MODE ? { payment, file } : payment);
  if (file && !DEMO_MODE) { try { return await sendImage('POST', `/payments/${rec.id}/proof`, file); } catch (e) { e.message = `The payment was saved, but the screenshot could not be attached: ${e.message}`; e.saved = rec; throw e; } }
  return rec;
}
export const uploadPaymentProof = (id, file) => sendImage('POST', `/payments/${encodeURIComponent(id)}/proof`, file);
// ---- Payment screenshots: one workflow, two doors (Inbox and Payments) ----------------------------------------------------
// The reading is ALWAYS done by the real server (Groq vision), in demo mode too: demo mode only decides where the demo orders and the
// resulting payment records live (in the browser). If the server cannot be reached, nothing is read or invented.
// Returns { extraction: { amount, transactionId, paymentDate, paymentMethod, recipientDetails, extractionConfidence, warnings, model }, duplicate }.
export async function readPaymentScreenshot(file) {
  const r = await sendImage('POST', '/payments/read-image', file, { live: true });
  if (DEMO_MODE && !r.duplicate) { const { handleMockRequest } = await import('../mock/mockApi.js'); return { ...r, duplicate: (await handleMockRequest('POST', '/payments/check-proof', { file })).duplicate }; }
  return r;
}
// Reads a screenshot and files it as Verification pending on an order (used when an image and its order are known).
export async function extractPaymentImage({ file, orderId, conversationId }) {
  if (!DEMO_MODE) return sendImage('POST', `/payments/extract-image?${new URLSearchParams({ orderId: orderId ?? '', ...(conversationId ? { conversationId } : {}) })}`, file);
  const { extraction } = await readPaymentScreenshot(file);
  const { handleMockRequest } = await import('../mock/mockApi.js');
  return handleMockRequest('POST', '/payments/extract-image', { file, orderId, conversationId, extraction });
}
// A picture in a chat: save the customer's screenshot into the conversation, then read it on request.
export const uploadConversationImage = (conversationId, file) => sendImage('POST', `/conversations/${encodeURIComponent(conversationId)}/attachments`, file);
export async function extractMessagePayment(conversationId, message) {
  const path = `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(message.id)}/extract-payment`;
  if (!DEMO_MODE) return request('POST', path);
  if (message.payment) return request('POST', path, {}); // already filed: the mock returns it (asked twice, one record)
  const blob = await (await fetch(message.attachment.url)).blob(); // the picture saved in the browser's demo conversation
  const file = new File([blob], 'screenshot', { type: blob.type });
  const { extraction } = await readPaymentScreenshot(file);
  const { handleMockRequest } = await import('../mock/mockApi.js');
  return handleMockRequest('POST', path, { file, extraction });
}
// Where a stored screenshot is shown from (live: through the API; demo: an in-memory image).
export const proofSrc = (proof) => (!proof?.url ? null : /^(data:|https?:)/.test(proof.url) ? proof.url : `${API_BASE_URL}${proof.url}`);
export const attachmentSrc = proofSrc;

export const getIntegrations = () => request('GET', '/integrations');
export const connectIntegration = (channel) => request('POST', `/integrations/${channel}/connect`, {});

// Not in docs/api-contract.md yet (proposed addition, implemented in server/README.md): conversations stored from
// Meta webhooks. Demo mode returns clearly-labelled sample conversations.
export const getConversations = () => request('GET', '/conversations');
// patch: { read: true } and/or { orderId: string | null }
export const updateConversation = (id, patch) => request('PATCH', `/conversations/${encodeURIComponent(id)}`, patch);
