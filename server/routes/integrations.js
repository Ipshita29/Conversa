import { Router } from 'express';
import { requireDb } from '../middleware/requireDb.js';
import { list, connect, instagramOAuthStart, instagramOAuthCallback, whatsappSignup, whatsappCompleteSignup, disconnectChannel, diagnostics, testConnection, registerWebhook } from '../controllers/integrationController.js';

const r = Router();
r.get('/', list);
r.post('/instagram/oauth/start', requireDb, instagramOAuthStart);
r.get('/instagram/oauth/callback', requireDb, instagramOAuthCallback);
r.get('/whatsapp/signup', whatsappSignup);
r.post('/whatsapp/complete', requireDb, whatsappCompleteSignup);
r.get('/:channel/diagnostics', requireDb, diagnostics);
r.post('/:channel/test', requireDb, testConnection);
r.post('/:channel/register-webhook', requireDb, registerWebhook); // point Meta at SERVER_URL and subscribe the app (after a tunnel/address change)
r.post('/:channel/disconnect', requireDb, disconnectChannel);
r.post('/:channel/connect', connect);
export default r;
