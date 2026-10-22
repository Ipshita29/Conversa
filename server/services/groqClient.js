import { config } from '../config/env.js';
import { ApiError } from '../utils/errors.js';

const aiUnavailable = (message) => new ApiError(503, 'AI_UNAVAILABLE', message);

// gpt-oss models spend part of max_tokens on hidden reasoning. A small cap lets the reasoning eat the whole budget, which Groq
// reports as HTTP 400 "json_validate_failed" with an empty failed_generation. Low effort plus a roomy cap avoids it.
const MAX_TOKENS = 2000;
const reasoningParams = (model) => (/gpt-oss/i.test(model) ? { reasoning_effort: 'low' } : {});

// The provider's full error goes to the server log only (never the API key, never the prompt); the client gets a short, actionable message.
async function providerError(res, cfg) {
  let body = null;
  try { body = (await res.json())?.error ?? null; } catch { /* body was not JSON */ }
  console.error(`[ai] Groq request failed: status=${res.status} model=${cfg.model} code=${body?.code ?? 'n/a'} type=${body?.type ?? 'n/a'} message=${JSON.stringify(body?.message ?? null)}`);
  return body;
}

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
        model: cfg.model, temperature: 0, max_tokens: MAX_TOKENS, response_format: { type: 'json_object' }, ...reasoningParams(cfg.model),
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw aiUnavailable(err.name === 'AbortError' ? 'The AI service timed out. Please try again or enter the order manually.' : 'The AI service could not be reached. Please try again or enter the order manually.');
  } finally {
    clearTimeout(timer);
  }

  if (res.ok) { /* parsed below */ } else {
    const body = await providerError(res, cfg);
    if (res.status === 429) {
      const e = aiUnavailable('The AI service is rate-limited right now. Please retry in a moment.');
      e.retryAfter = res.headers?.get?.('retry-after') ?? null;
      throw e;
    }
    if (res.status === 401 || res.status === 403) throw aiUnavailable('The AI service rejected the server credentials. Check GROQ_API_KEY.');
    if (res.status === 404 || body?.code === 'model_not_found') throw aiUnavailable(`The configured AI model (${cfg.model}) was not found. Check GROQ_MODEL.`);
    if (body?.code === 'json_validate_failed') throw aiUnavailable("The AI couldn't read that message into an order. Try again, shorten it, or enter the order manually.");
    if (res.status >= 500) throw aiUnavailable('The AI provider is having problems right now. Please try again shortly or enter the order manually.');
    throw aiUnavailable('The AI service rejected the request. The details are in the server log; you can enter the order manually.');
  }

  let content;
  try { content = (await res.json()).choices?.[0]?.message?.content; } catch { content = null; }
  try { return JSON.parse(content); } catch { throw aiUnavailable('The AI service returned an unreadable response.'); }
}
