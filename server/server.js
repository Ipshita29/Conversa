import { config } from './config/env.js';
import { connectDb } from './config/db.js';
import { createApp } from './app.js';
import { isDbReady } from './config/db.js';
import { refreshStaleDemo } from './services/demoSeed.js';

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
});
