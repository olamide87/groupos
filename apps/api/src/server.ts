import { config } from 'dotenv';
import { app } from './app.js';
import { connectDatabase, disconnectDatabase } from './database.js';

config({ path: new URL('../../../.env', import.meta.url) });

const port = Number(process.env.PORT ?? 4100);
try {
  await connectDatabase();
  const server = app.listen(port, () => console.log(`GroupOS API listening on port ${port}`));
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 10_000);
    deadline.unref();
    server.close(async () => {
      try {
        await disconnectDatabase();
      } catch {
        process.exitCode = 1;
      } finally {
        clearTimeout(deadline);
      }
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  server.once('error', () => {
    console.error('API listener failed');
    process.exitCode = 1;
    shutdown();
  });
} catch {
  // Connection errors can contain credentials; do not print the raw error.
  console.error('Database initialization failed; check configuration and availability');
  await disconnectDatabase();
  process.exitCode = 1;
}
