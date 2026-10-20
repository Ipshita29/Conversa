import { config } from './config/env.js';
import { connectDb } from './config/db.js';
import { createApp } from './app.js';

const app = createApp();

app.listen(config.port, () => {
  console.log(`Conversa server running on http://localhost:${config.port}`);
  connectDb();
});
