import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './core/config.js';
import { authenticate, sendError } from './core/context.js';
import { startWorkers } from './workers.js';
import { modules } from './modules/index.js';

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    bodyLimit: 10 * 1024 * 1024,
  });

  await app.register(cors, { origin: config.corsOrigin as any, credentials: true });
  await app.register(jwt, { secret: config.jwtSecret, sign: { expiresIn: config.jwtTtl } });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Maqta PCS API',
        version: '0.1.0',
        description:
          'Port Community System B2B/B2G API. Authenticate with `Authorization: Bearer <JWT>` (portal users) or `x-api-key` (system-to-system). All resources are scoped to the caller\'s port (tenant).',
      },
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer' },
          apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
        },
      },
      security: [{ bearer: [] }, { apiKey: [] }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  app.setErrorHandler((err, _req, reply) => sendError(err, reply));

  // Every /api route requires authentication unless marked { config: { public: true } }.
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/docs')) return;
    if ((req.routeOptions.config as any)?.public) return;
    await authenticate(req);
  });

  app.get('/health', { config: { public: true } }, async () => ({ status: 'ok', service: 'pcs-api', time: new Date().toISOString() }));

  for (const m of modules) await app.register(m, { prefix: '/api' });

  // Serve the built web portal (single image deployment); SPA fallback for client-side routes.
  const webDist = process.env.WEB_DIST ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.status(404).send({ error: 'Not found' });
    });
  }
  return app;
}

if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
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
}
