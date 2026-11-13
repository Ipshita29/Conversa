import * as whatsapp from './whatsappService.js';
import * as instagram from './instagramService.js';
import { getRecord, resolveConfig, describe } from './credentials.js';

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
    return { ...live, state, source: d.source, expiresAt: d.expiresAt, accountLabel: live.accountLabel ?? d.accountLabel, statusReason: state === 'connected' ? live.statusReason : (d.status === 'expired' || d.status === 'needs_attention' ? d.statusReason : null) ?? live.statusReason };
  }));
  cache = { at: Date.now(), items };
  return items;
}
export const clearStatusCache = () => { cache = { at: 0, items: null }; };
