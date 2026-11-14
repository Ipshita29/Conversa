import { asyncHandler, ApiError } from '../utils/errors.js';
import { config } from '../config/env.js';
import { log } from '../utils/log.js';
import { channels, listStatuses, clearStatusCache } from '../services/integrations/index.js';
import { disconnect, resolveConfig } from '../services/integrations/credentials.js';
import { lastActivity, testWhatsApp, registerWhatsAppWebhook } from '../services/integrations/diagnostics.js';
import { instagramStart, instagramComplete, whatsappSignupConfig, whatsappComplete } from '../services/integrations/oauth.js';

export const list = asyncHandler(async (req, res) => res.json({
  items: await listStatuses(),
  // Where Meta must be pointed (shown in Settings): public https URLs of THIS server. No secrets.
  webhooks: { whatsapp: config.serverUrl ? `${config.serverUrl}/api/webhooks/whatsapp` : null, instagram: config.serverUrl ? `${config.serverUrl}/api/webhooks/instagram` : null, instagramOAuthRedirect: config.serverUrl ? `${config.serverUrl}/api/integrations/instagram/oauth/callback` : null },
}));

// Re-verifies the credentials with Meta ("Connect" for an account configured through the environment).
export const connect = asyncHandler(async (req, res) => {
  const { channel } = req.params;
  const svc = channels[channel];
  if (!svc) throw new ApiError(404, 'NOT_FOUND', `Unknown channel '${channel}'.`);
  clearStatusCache();
  const status = await svc.checkStatus({}, await resolveConfig());
  if (status.status !== 'connected') throw new ApiError(503, 'INTEGRATION_UNAVAILABLE', status.statusReason);
  res.json({ channel, status: 'connected', accountLabel: status.accountLabel, authorizationUrl: null, statusReason: status.statusReason });
});

// GET /api/integrations/:channel/diagnostics: when messages last came in and went out, the webhook's last error, the last picture download.
export const diagnostics = asyncHandler(async (req, res) => {
  if (!channels[req.params.channel]) throw new ApiError(404, 'NOT_FOUND', `Unknown channel '${req.params.channel}'.`);
  res.json({ channel: req.params.channel, ...(await lastActivity(req.params.channel)) });
});

// POST /api/integrations/whatsapp/test: real checks against Meta, our public address and the database (never just "is a variable set").
export const testConnection = asyncHandler(async (req, res) => {
  if (req.params.channel !== 'whatsapp') throw new ApiError(400, 'UNSUPPORTED', 'Test connection is available for WhatsApp.');
  clearStatusCache();
  res.json({ channel: 'whatsapp', checkedAt: new Date().toISOString(), ...(await testWhatsApp()) });
});

export const registerWebhook = asyncHandler(async (req, res) => {
  if (req.params.channel !== 'whatsapp') throw new ApiError(400, 'UNSUPPORTED', 'Registering the webhook is available for WhatsApp.');
  clearStatusCache();
  res.json({ channel: 'whatsapp', ...(await registerWhatsAppWebhook()) });
});

// POST /api/integrations/instagram/oauth/start -> { url }: where to send the owner to log in to Instagram and grant messaging access.
export const instagramOAuthStart = asyncHandler(async (req, res) => res.json(await instagramStart()));

// GET /api/integrations/instagram/oauth/callback?code&state: Meta sends the owner's browser back here. We exchange the code and return them to Settings.
export const instagramOAuthCallback = asyncHandler(async (req, res) => {
  const back = (result, reason) => res.redirect(`${config.clientUrl || config.clientOrigins[0] || ''}/settings?integration=instagram&result=${result}${reason ? `&reason=${encodeURIComponent(reason)}` : ''}`);
  if (req.query.error) return back('cancelled', req.query.error_description || req.query.error);
  try { await instagramComplete({ code: req.query.code, state: req.query.state }); clearStatusCache(); return back('connected'); }
  catch (e) { log.warn('instagram', `OAuth callback failed: ${e.message}`); return back('error', e.message); }
});

// GET /api/integrations/whatsapp/signup: what the browser needs to launch Embedded Signup (ids only; never a secret).
export const whatsappSignup = asyncHandler(async (req, res) => res.json(whatsappSignupConfig()));

// POST /api/integrations/whatsapp/complete { code, wabaId, phoneNumberId }: the result of Embedded Signup, forwarded by the browser.
export const whatsappCompleteSignup = asyncHandler(async (req, res) => {
  const r = await whatsappComplete(req.body ?? {});
  clearStatusCache();
  res.status(201).json({ channel: 'whatsapp', status: 'connected', ...r });
});

export const disconnectChannel = asyncHandler(async (req, res) => {
  if (!channels[req.params.channel]) throw new ApiError(404, 'NOT_FOUND', `Unknown channel '${req.params.channel}'.`);
  await disconnect(req.params.channel);
  clearStatusCache();
  res.json({ channel: req.params.channel, status: 'disconnected' });
});
