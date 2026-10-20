import { config } from '../config/env.js';
import { ApiError } from '../utils/errors.js';

const aiUnavailable = (message) => new ApiError(503, 'AI_UNAVAILABLE', message);

// Calls Groq's OpenAI-compatible chat completions endpoint and returns the parsed JSON object from the model.
// The API key stays on the server; error messages never include it.
export async function groqJson({ system, user }, { fetchImpl = fetch, cfg = config.groq } = {}) {
  if (!cfg.apiKey) throw aiUnavailable('The AI service is not configured on this server (GROQ_API_KEY is missing). You can enter the order manually.');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  let res;
  try {
    res = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model, temperature: 0, max_tokens: 700, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw aiUnavailable(err.name === 'AbortError' ? 'The AI service timed out. Please try again or enter the order manually.' : 'The AI service could not be reached. Please try again or enter the order manually.');
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) {
    const e = aiUnavailable('The AI service is rate-limited right now. Please retry in a moment.');
    e.retryAfter = res.headers?.get?.('retry-after') ?? null;
    throw e;
  }
  if (res.status === 401 || res.status === 403) throw aiUnavailable('The AI service rejected the server credentials. Check GROQ_API_KEY.');
  if (!res.ok) throw aiUnavailable(`The AI service returned an error (HTTP ${res.status}).`);

  let content;
  try { content = (await res.json()).choices?.[0]?.message?.content; } catch { content = null; }
  try { return JSON.parse(content); } catch { throw aiUnavailable('The AI service returned an unreadable response.'); }
}
