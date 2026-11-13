import { config, validateConfig } from './config/env.js';
import { log } from './utils/log.js';
import { connectDb } from './config/db.js';
import { createApp } from './app.js';
import { isDbReady } from './config/db.js';
import { refreshStaleDemo } from './services/demoSeed.js';
import { refreshInstagramIfDue } from './services/integrations/credentials.js';

// Fail fast on a production server that cannot work; everything else is a warning, because demo mode needs no Meta credentials.
const check = validateConfig();
for (const w of check.warnings) log.warn('config', w);
if (check.errors.length) { for (const e of check.errors) log.error('config', e); if (config.nodeEnv === 'production') process.exit(1); }

const app = createApp();

// Demo orders are anchored to the moment they were seeded. While the server runs, re-anchor them whenever their deadlines have passed,
// so the sample bakery never decays into a pile of "overdue" orders that pushes real work days into the future. Real orders are untouched.
async function keepDemoFresh() {
  if (!isDbReady()) return;
  try { if (await refreshStaleDemo()) console.log('Demo orders were out of date; re-anchored them to now.'); }
  catch (err) { console.error(`Could not refresh the demo orders: ${err.message}`); }
}

app.listen(config.port, async () => {
  console.log(`Conversa server running on http://localhost:${config.port}`);
  await connectDb();
  await keepDemoFresh();
  setInterval(keepDemoFresh, 10 * 60 * 1000).unref();
  // Instagram tokens last 60 days: renew them in good time (a no-op unless one is due).
  setInterval(() => { if (isDbReady()) refreshInstagramIfDue().catch((e) => log.warn('instagram', `Token refresh failed: ${e.message}`)); }, 12 * 3600000).unref();
});
