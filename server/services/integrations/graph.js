import { config } from '../../config/env.js';

// GET against a Meta Graph endpoint with a timeout. Tokens are sent in a header and never logged or returned.
export async function graphGet(url, token, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
    let body = null;
    try { body = await res.json(); } catch { /* ignore */ }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: null, error: err.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

export const graphBase = () => `https://graph.facebook.com/${config.meta.graphVersion}`;
