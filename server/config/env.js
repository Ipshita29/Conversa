import 'dotenv/config';

const int = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);

// All configuration comes from environment variables. Secrets are never logged or returned by the API.
const list = (v) => (v || '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN || '';

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 5000),
  serverUrl: (process.env.SERVER_URL || '').replace(/\/$/, ''), // this API's public https origin: the base of the webhook and OAuth callback URLs
  clientUrl: (process.env.CLIENT_URL || '').replace(/\/$/, ''), // the web app's public origin: where the owner returns to after connecting an account
  // Encrypts the Meta access tokens kept in the database (AES-256-GCM). Required as soon as an account is connected through OAuth.
  encryptionKey: process.env.ENCRYPTION_KEY || '',
  // Browser origins allowed to call the API: CLIENT_ORIGIN (comma-separated), plus the two local Vite dev servers outside production.
  clientOrigins: [...new Set([
    ...list(process.env.CLIENT_ORIGIN), ...list(process.env.CLIENT_URL),
    ...(process.env.NODE_ENV === 'production' ? [] : ['http://localhost:5173', 'http://localhost:5174']),
  ])],
  mongoUri: process.env.MONGODB_URI || '',
  businessTimezone: process.env.BUSINESS_TIMEZONE || 'Asia/Kolkata',
  groq: {
    apiKey: process.env.GROQ_API_KEY || '',
    model: process.env.GROQ_MODEL || 'openai/gpt-oss-20b',
    timeoutMs: int(process.env.GROQ_TIMEOUT_MS, 15000),
    visionModel: process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct', // reads payment screenshots
  },
  payments: { proofDir: process.env.PAYMENT_PROOF_DIR || '' }, // empty = server/storage/proofs
  meta: {
    // The Graph API version every call uses. v26.0 is the current release (July 2026); override with META_GRAPH_API_VERSION to pin another.
    graphVersion: process.env.META_GRAPH_API_VERSION || process.env.META_GRAPH_VERSION || 'v26.0',
    appId: process.env.META_APP_ID || '',
    appSecret: process.env.META_APP_SECRET || '', // signs webhooks (X-Hub-Signature-256) and exchanges OAuth codes. Server-side only.
    whatsapp: {
      accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '', // optional: a system-user token. Connecting through Embedded Signup stores one (encrypted) instead.
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
      businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
      embeddedSignupConfigId: process.env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID || '', // the Facebook Login for Business configuration used by Embedded Signup
      verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || verifyToken,
    },
    instagram: {
      accessToken: process.env.INSTAGRAM_ACCESS_TOKEN || '',
      businessAccountId: process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || '',
      verifyToken: process.env.INSTAGRAM_VERIFY_TOKEN || verifyToken,
    },
  },
  aiRateLimitPerMinute: int(process.env.AI_RATE_LIMIT_PER_MINUTE, 20),
};

// Startup checks. `errors` stop a production server (it could not work); `warnings` are logged and the app keeps running, because demo mode needs no
// Meta credentials at all. Messages name the variable to set and never print a value.
export function validateConfig(c = config) {
  const errors = []; const warnings = [];
  const prod = c.nodeEnv === 'production';
  if (!c.mongoUri) (prod ? errors : warnings).push('MONGODB_URI is not set: orders, messages and payments need a database.');
  if (prod && c.clientOrigins.length === 0) errors.push('CLIENT_URL (or CLIENT_ORIGIN) is not set: the browser app would be blocked by CORS.');
  if (prod && !c.serverUrl) warnings.push('SERVER_URL is not set: webhook and OAuth callback URLs cannot be shown in Settings.');
  const m = c.meta; const wa = m.whatsapp; const ig = m.instagram;
  const anyMeta = Boolean(m.appId || m.appSecret || wa.accessToken || ig.accessToken || wa.phoneNumberId);
  if (anyMeta) {
    if (!m.appSecret) warnings.push('META_APP_SECRET is not set: incoming webhooks are refused (their signature cannot be checked).');
    if (!wa.verifyToken && !ig.verifyToken) warnings.push('META_WEBHOOK_VERIFY_TOKEN is not set: Meta cannot verify the webhook URLs.');
    if (wa.accessToken && !wa.phoneNumberId) warnings.push('WHATSAPP_ACCESS_TOKEN is set but WHATSAPP_PHONE_NUMBER_ID is not.');
    if (m.appId && !c.encryptionKey) warnings.push('ENCRYPTION_KEY is not set: accounts cannot be connected through OAuth, because their tokens could not be stored encrypted.');
  }
  if (c.encryptionKey && c.encryptionKey.length < 32) errors.push('ENCRYPTION_KEY must be at least 32 characters (generate one with: openssl rand -base64 32).');
  return { errors, warnings };
}
