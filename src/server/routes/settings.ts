// /health, /settings*, /models

import { type HealthResponse, ROUTES, setOpenRouterKeyBody, updateSettingsBody } from '@shared/api';
import { Hono } from 'hono';
import type { Core } from '../../core/types';
import { readJson } from '../http';

export function settingsRoutes(core: Core, info: { mode: 'dev' | 'prod'; version: string }): Hono {
  const r = new Hono();

  r.get(ROUTES.health, (c) => c.json<HealthResponse>({ ok: true, version: info.version, mode: info.mode }));

  r.get(ROUTES.settings, async (c) => c.json(await core.settings.get()));

  r.patch(ROUTES.settings, async (c) => {
    const body = await readJson(c, updateSettingsBody);
    return c.json(await core.settings.update(body));
  });

  r.put(ROUTES.openRouterKey, async (c) => {
    const { apiKey } = await readJson(c, setOpenRouterKeyBody);
    // Validate with the provider first (throws ProviderError: invalid_api_key → 400, network_error → 502, …).
    await core.provider.validateKey(apiKey, c.req.raw.signal);
    return c.json(await core.settings.setApiKey(apiKey));
  });

  r.delete(ROUTES.openRouterKey, async (c) => c.json(await core.settings.clearApiKey()));

  r.get(ROUTES.models, async (c) => {
    const refresh = c.req.query('refresh') === '1';
    return c.json(await core.models.list({ refresh, signal: c.req.raw.signal }));
  });

  return r;
}
