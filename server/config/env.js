import 'dotenv/config';

const int = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);

// All configuration comes from environment variables. Secrets are never logged or returned by the API.
export const config = {
  port: int(process.env.PORT, 5000),
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  mongoUri: process.env.MONGODB_URI || '',
  businessTimezone: process.env.BUSINESS_TIMEZONE || 'Asia/Kolkata',
  groq: {
    apiKey: process.env.GROQ_API_KEY || '',
    model: process.env.GROQ_MODEL || 'openai/gpt-oss-20b',
    timeoutMs: int(process.env.GROQ_TIMEOUT_MS, 15000),
  },
  meta: {
    graphVersion: process.env.META_GRAPH_VERSION || 'v21.0',
    appSecret: process.env.META_APP_SECRET || '',
    whatsapp: {
      accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
      verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
    },
    instagram: {
      accessToken: process.env.INSTAGRAM_ACCESS_TOKEN || '',
      verifyToken: process.env.INSTAGRAM_VERIFY_TOKEN || '',
    },
  },
  aiRateLimitPerMinute: int(process.env.AI_RATE_LIMIT_PER_MINUTE, 20),
};
