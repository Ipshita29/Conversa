import * as whatsapp from './whatsappService.js';
import * as instagram from './instagramService.js';

export const channels = { whatsapp, instagram };

let cache = { at: 0, items: null };
export async function listStatuses(deps = {}, { fresh = false } = {}) {
  if (!fresh && cache.items && Date.now() - cache.at < 60000) return cache.items;
  const items = await Promise.all(Object.values(channels).map((c) => c.checkStatus(deps)));
  cache = { at: Date.now(), items };
  return items;
}
export const clearStatusCache = () => { cache = { at: 0, items: null }; };
