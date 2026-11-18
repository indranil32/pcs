// Process entry point: migrate, optionally seed, then serve. server.ts stays side-effect free so seed/tests can import it.
import { buildApp } from './server.js';
import { config } from './core/config.js';
import { startWorkers } from './workers.js';
if (process.env.MIGRATE_ON_START !== 'false') {
  const { migrate } = await import('./db/migrate.js');
  await migrate();
}
if (process.env.SEED_DEMO_DATA === 'true') {
  const { seed } = await import('./db/seed.js');
  await seed();
}
const app = await buildApp();
await app.listen({ port: config.port, host: '0.0.0.0' });
if (config.workers) startWorkers(app.log);
