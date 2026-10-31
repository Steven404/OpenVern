// Standalone dev API server on 127.0.0.1:8787 (plan §3.2). S0 stub: only `GET /api/health`.
// S5 replaces this with `createApp(createCore(...))`.

import { serve } from '@hono/node-server';
import type { HealthResponse } from '@shared/api';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import pkg from '../../package.json' with { type: 'json' };

const HOST = '127.0.0.1';
const PORT = 8787;

const app = new Hono().basePath('/api');
app.use(logger());
app.get('/health', (c) => c.json<HealthResponse>({ ok: true, version: pkg.version, mode: 'dev' }));

serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  console.log(`harness dev API on http://${info.address}:${info.port}/api`);
});
