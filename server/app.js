import express from 'express';
import cors from 'cors';
import { config } from './config/env.js';
import { isDbReady } from './config/db.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import orders from './routes/orders.js';
import dashboard from './routes/dashboard.js';
import analytics from './routes/analytics.js';
import board from './routes/board.js';
import planner from './routes/planner.js';
import ai from './routes/ai.js';
import settings from './routes/settings.js';
import integrations from './routes/integrations.js';
import webhooks from './routes/webhooks.js';
import conversations from './routes/conversations.js';
import payments from './routes/payments.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(cors({ origin: config.clientOrigin.split(',').map((s) => s.trim()) }));
  // The raw body is kept for webhook signature verification.
  app.use(express.json({ limit: '256kb', verify: (req, res, buf) => { req.rawBody = buf; } }));

  app.get('/api/health', (req, res) => res.json({ status: 'ok', database: isDbReady() ? 'connected' : 'disconnected' }));
  app.use('/api/dashboard', dashboard);
  app.use('/api/analytics', analytics);
  app.use('/api/board', board);
  app.use('/api/orders', orders);
  app.use('/api/ai', ai);
  app.use('/api/planner', planner);
  app.use('/api/settings', settings);
  app.use('/api/integrations', integrations);
  app.use('/api/conversations', conversations);
  app.use('/api/payments', payments);
  app.use('/api/webhooks', webhooks);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
