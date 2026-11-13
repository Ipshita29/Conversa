import * as whatsapp from './whatsappService.js';
import * as instagram from './instagramService.js';
import { getRecord, resolveConfig, describe } from './credentials.js';
import { instagramConnectReadiness, whatsappSignupConfig } from './oauth.js';

export const channels = { whatsapp, instagram };

// The connection state shown in Settings, one of: not_connected, connecting, connected, needs_attention, expired. Meta is asked (cheaply, and cached for a
// minute) whether the credentials actually work; a channel is never "connected" on the strength of stored settings alone.
let cache = { at: 0, items: null };
export async function listStatuses(deps = {}, { fresh = false } = {}) {
  if (!fresh && cache.items && Date.now() - cache.at < 60000) return cache.items;
  const cfg = await resolveConfig();
  const items = await Promise.all(Object.entries(channels).map(async ([channel, svc]) => {
    const live = await svc.checkStatus(deps, cfg);
    const d = describe(channel, await getRecord(channel), cfg);
    const hasCreds = svc.missingConfig(cfg).length === 0;
    let state;
    if (live.status === 'connected') state = 'connected';
    else if (d.status === 'expired') state = 'expired';
    else if (d.status === 'connecting') state = 'connecting';
    else if (d.status === 'needs_attention' || hasCreds) state = 'needs_attention';
    else state = 'not_connected';
    // What Settings tells the owner. The environment-token message from checkStatus ("Missing environment variables: INSTAGRAM_ACCESS_TOKEN...") only
    // concerns a token configured BY HAND; it must never be shown for the sign-in flow, which produces its own token.
    const ready = channel === 'instagram' ? instagramConnectReadiness(cfg) : { ...whatsappSignupConfig(cfg), ready: whatsappSignupConfig(cfg).ready };
    const connect = { ready: ready.ready, missing: ready.missing ?? [] };
    const reason = state === 'connected' ? live.statusReason
      : state === 'connecting' ? 'Waiting for you to finish signing in. Use Connect to start again if the window was closed.'
      : state === 'not_connected' ? (connect.ready ? 'Not connected yet. Use Connect to sign in and choose the account.' : `To connect, the server still needs: ${connect.missing.join(', ')}.`)
      : d.statusReason ?? live.statusReason;
    return { ...live, state, connect, statusReason: reason, source: d.source, expiresAt: d.expiresAt, accountLabel: live.accountLabel ?? d.accountLabel };
  }));
  cache = { at: Date.now(), items };
  return items;
}
export const clearStatusCache = () => { cache = { at: 0, items: null }; };
