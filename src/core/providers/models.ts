// Model catalog (plan S2.10): 1 h TTL in memory + a JSON cache file, stale cache on fetch failure.
// Implements the locked `ModelCatalog` interface from `../types`.

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { REASONING_EFFORTS } from '@shared/constants';
import type { ModelInfo, ReasoningEffort } from '@shared/types';
import type { ModelCatalog } from '../types';
import type { Provider } from './types';

export const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;
/** After a failed fetch, non-forced calls serve the stale cache (or rethrow) for this long before retrying. */
export const MODEL_FETCH_BACKOFF_MS = 60 * 1000;

/** Bumped when the `ModelInfo` shape in the cache changes: an older entry is refetched, but still serves as stale data. */
const CACHE_VERSION = 2;

export interface ModelCatalogOptions {
  provider: Provider;
  /** Absolute path of `<dataDir>/cache/models.json`. */
  cacheFile: string;
  /** Epoch ms. Injected for tests. */
  now?: () => number;
}

interface CacheEntry {
  version: number;
  fetchedAt: number; // epoch ms
  models: ModelInfo[];
}

const EFFORT_SET: ReadonlySet<string> = new Set(REASONING_EFFORTS);

/**
 * Drops an invalid F3 effort field from a cache entry instead of rejecting the whole cache. Known levels are also
 * put back in `REASONING_EFFORTS` order.
 */
function sanitizeModel(m: ModelInfo): ModelInfo {
  const raw = m as unknown as Record<string, unknown>;
  const efforts = Array.isArray(raw.reasoningEfforts)
    ? REASONING_EFFORTS.filter((e) => (raw.reasoningEfforts as unknown[]).includes(e))
    : [];
  const defaultEffort =
    typeof raw.defaultEffort === 'string' && EFFORT_SET.has(raw.defaultEffort)
      ? (raw.defaultEffort as ReasoningEffort)
      : undefined;
  const rest = { ...m };
  delete rest.reasoningEfforts;
  delete rest.defaultEffort;
  return {
    ...rest,
    ...(efforts.length > 0 ? { reasoningEfforts: [...efforts] } : {}),
    ...(defaultEffort !== undefined ? { defaultEffort } : {}),
  };
}

function isModelInfo(m: unknown): m is ModelInfo {
  if (typeof m !== 'object' || m === null) return false;
  const o = m as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    typeof o.supportsTools === 'boolean' &&
    typeof o.supportsImages === 'boolean' &&
    // F3: optional so a cache written before F3 still loads; a missing value counts as false.
    (o.supportsReasoning === undefined || typeof o.supportsReasoning === 'boolean')
  );
}

async function readCache(file: string): Promise<CacheEntry | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { version, fetchedAt, models } = parsed as { version?: unknown; fetchedAt?: unknown; models?: unknown };
    const t = typeof fetchedAt === 'string' ? Date.parse(fetchedAt) : Number.NaN;
    if (Number.isNaN(t) || !Array.isArray(models) || !models.every(isModelInfo)) return null;
    return {
      version: typeof version === 'number' && Number.isInteger(version) ? version : 0,
      fetchedAt: t,
      models: models.map(sanitizeModel),
    };
  } catch {
    return null; // missing or corrupt: treat as no cache
  }
}

/** Atomic write: tmp file in the same directory, fsync, rename. */
async function writeCache(file: string, entry: CacheEntry): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const json = JSON.stringify({
    version: entry.version,
    fetchedAt: new Date(entry.fetchedAt).toISOString(),
    models: entry.models,
  });
  try {
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(json, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

const AUTHOR_BY_SLUG: Record<string, string> = {
  deepseek: 'DeepSeek',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  'meta-llama': 'Meta',
  mistralai: 'Mistral AI',
  qwen: 'Alibaba (Qwen)',
  'x-ai': 'xAI',
  moonshotai: 'Moonshot AI',
  'z-ai': 'Zhipu AI',
  openrouter: 'OpenRouter',
};

/** Maker for a model-id slug (the part before "/"): the known map, else the slug itself. */
export function authorFromSlug(slug: string): string {
  return AUTHOR_BY_SLUG[slug.toLowerCase()] ?? slug;
}

/** OpenRouter names look like "DeepSeek: DeepSeek V3.1": maker before ": ", display name after. */
export function splitModelName(name: string): { author?: string; displayName: string } {
  const i = name.indexOf(': ');
  if (i <= 0) return { displayName: name };
  return { author: name.slice(0, i), displayName: name.slice(i + 2) };
}

function fallbackModel(id: string): ModelInfo {
  return {
    id,
    name: id,
    author: authorFromSlug(id.split('/')[0] ?? id),
    contextLength: null,
    supportsTools: true,
    supportsImages: false,
    // Unknown model: never risk a `reasoning` field it may reject (F3).
    supportsReasoning: false,
    promptPricePerMTok: null,
    completionPricePerMTok: null,
  };
}

export function createModelCatalog(opts: ModelCatalogOptions): ModelCatalog {
  const { provider, cacheFile } = opts;
  const now = opts.now ?? Date.now;

  let memory: CacheEntry | null = null;
  let diskLoaded = false;
  let lastFailure: { at: number; error: unknown } | null = null;

  async function loadDisk(): Promise<void> {
    if (diskLoaded) return;
    diskLoaded = true;
    const entry = await readCache(cacheFile);
    if (entry && (!memory || entry.fetchedAt > memory.fetchedAt)) memory = entry;
  }

  // Read through a function: TS cannot see that `loadDisk()` assigns `memory`.
  const cached = (): CacheEntry | null => memory;

  async function list(o: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<ModelInfo[]> {
    await loadDisk();
    if (!o.refresh) {
      const hit = cached();
      // A cache written by an older format is not fresh: refetch it, but keep it as the stale fallback below.
      if (hit && hit.version === CACHE_VERSION && now() - hit.fetchedAt < MODEL_CACHE_TTL_MS) return hit.models;
      if (lastFailure && now() - lastFailure.at < MODEL_FETCH_BACKOFF_MS) {
        if (hit) return hit.models;
        throw lastFailure.error;
      }
    }
    try {
      const models = await provider.listModels(o.signal);
      const entry = { version: CACHE_VERSION, fetchedAt: now(), models };
      memory = entry;
      lastFailure = null;
      await writeCache(cacheFile, entry).catch(() => {}); // a failed cache write must not fail the call
      return models;
    } catch (err) {
      if (o.signal?.aborted) throw err; // the caller gave up; don't mask that with stale data
      lastFailure = { at: now(), error: err };
      const stale = cached();
      if (stale) return stale.models;
      throw err;
    }
  }

  return {
    list,
    resetFailure() {
      lastFailure = null;
    },
    async get(id) {
      try {
        const models = await list();
        return models.find((m) => m.id === id) ?? fallbackModel(id);
      } catch {
        return fallbackModel(id);
      }
    },
  };
}
