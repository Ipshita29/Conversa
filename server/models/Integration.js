import mongoose from 'mongoose';

// One document per messaging channel: how this business is connected to WhatsApp or Instagram. The access token is only ever stored encrypted
// (see utils/crypto.js) and is never returned by any API. Credentials supplied through environment variables need no document at all.
export const INTEGRATION_STATES = ['connecting', 'connected', 'needs_attention', 'expired', 'disconnected'];
const integrationSchema = new mongoose.Schema({
  channel: { type: String, enum: ['whatsapp', 'instagram'], required: true, unique: true },
  status: { type: String, enum: INTEGRATION_STATES, default: 'disconnected' },
  statusReason: { type: String, default: null },
  accountId: { type: String, default: null },          // Instagram professional account id / WhatsApp phone number id
  accountLabel: { type: String, default: null },       // @handle / the business phone number
  businessAccountId: { type: String, default: null },  // WhatsApp Business Account (WABA) id
  scopes: { type: [String], default: [] },
  accessTokenEnc: { type: String, default: null },
  tokenExpiresAt: { type: Date, default: null },       // null = a token that does not expire
  tokenIssuedAt: { type: Date, default: null },
  lastRefreshAt: { type: Date, default: null },
  connectedAt: { type: Date, default: null },
  oauthStateHash: { type: String, default: null },     // CSRF guard for the Instagram OAuth round trip (hash only)
  oauthStateExpires: { type: Date, default: null },
}, { timestamps: true });

export default mongoose.models.Integration || mongoose.model('Integration', integrationSchema);
