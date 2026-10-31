// `createApp(core, { mode, version })` → the Hono app serving `/api/*` (plan §4.3). The same `app.fetch` runs in
// Node (`dev.ts`) and inside Electron's `protocol.handle` (S8.3).

import { API_PREFIX } from '@shared/api';
import { ERROR_STATUS, errorInfo } from '@shared/errors';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { toErrorInfo } from '../core/errors';
import type { Core } from '../core/types';
import { errorResponse } from './http';
import { security } from './middleware/security';
import { attachmentRoutes } from './routes/attachments';
import { chatRoutes } from './routes/chats';
import { projectRoutes } from './routes/projects';
import { settingsRoutes } from './routes/settings';

export interface AppOptions {
  mode: 'dev' | 'prod';
  version: string;
}

export function createApp(core: Core, opts: AppOptions): Hono {
  const app = new Hono();

  app.use(`${API_PREFIX}/*`, security);

  const api = new Hono();
  api.route('/', settingsRoutes(core, opts));
  api.route('/', projectRoutes(core));
  api.route('/', chatRoutes(core));
  api.route('/', attachmentRoutes(core));
  app.route(API_PREFIX, api);

  app.notFound((c) => errorResponse(c, 'not_found', 'Not found.'));

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      if (err.status === 413) return errorResponse(c, 'file_too_large');
      return c.json({ error: errorInfo('invalid_request') }, err.status as ContentfulStatusCode);
    }
    const info = toErrorInfo(err);
    // Never leak details of unexpected failures to the client; log them server-side (no request bodies, no keys).
    if (info.code === 'internal') console.error('[harness] unhandled error:', err instanceof Error ? err.stack : err);
    return c.json({ error: info }, ERROR_STATUS[info.code] as ContentfulStatusCode);
  });

  return app;
}
