import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelInfo } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createModelCatalog, MODEL_CACHE_TTL_MS, MODEL_FETCH_BACKOFF_MS } from './models';
import { type Provider, ProviderError } from './types';

const model = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  name: `Name of ${id}`,
  contextLength: 1000,
  supportsTools: true,
  supportsImages: true,
  promptPricePerMTok: 1,
  completionPricePerMTok: 2,
  ...extra,
});

const A = model('a/one');
const B = model('b/two', { supportsTools: false, supportsImages: false });

function fakeProvider(results: (ModelInfo[] | Error)[]) {
  let calls = 0;
  const signals: (AbortSignal | undefined)[] = [];
  const provider: Provider = {
    id: 'test',
    async listModels(signal) {
      signals.push(signal);
      const r = results[Math.min(calls++, results.length - 1)];
      if (r instanceof Error) throw r;
      return r ?? [];
    },
    async validateKey() {},
    // biome-ignore lint/correctness/useYield: never streams
    async *stream() {
      throw new Error('unused');
    },
  };
  return {
    provider,
    signals,
    get calls() {
      return calls;
    },
  };
}

let dir: string;
let cacheFile: string;
let clock: number;
const now = () => clock;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'openvern-models-'));
  cacheFile = join(dir, 'cache', 'models.json'); // directory does not exist yet
  clock = Date.parse('2026-10-31T12:00:00Z');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createModelCatalog', () => {
  it('fetches once, then serves from memory within the TTL', async () => {
    const p = fakeProvider([[A, B]]);
    const cat = createModelCatalog({ provider: p.provider, cacheFile, now });
    expect(await cat.list()).toEqual([A, B]);
    clock += MODEL_CACHE_TTL_MS - 1;
    expect(await cat.list()).toEqual([A, B]);
    expect(p.calls).toBe(1);
  });

  it('refetches after the TTL and when refresh is requested', async () => {
    const p = fakeProvider([[A], [A, B], [B]]);
    const cat = createModelCatalog({ provider: p.provider, cacheFile, now });
    expect(await cat.list()).toEqual([A]);
    clock += MODEL_CACHE_TTL_MS;
    expect(await cat.list()).toEqual([A, B]);
    expect(await cat.list({ refresh: true })).toEqual([B]);
    expect(p.calls).toBe(3);
  });

  it('writes the cache file atomically ({ fetchedAt, models }) and leaves no tmp files', async () => {
    const p = fakeProvider([[A, B]]);
    await createModelCatalog({ provider: p.provider, cacheFile, now }).list();
    const saved = JSON.parse(await readFile(cacheFile, 'utf8'));
    expect(saved).toEqual({ fetchedAt: '2026-10-31T12:00:00.000Z', models: [A, B] });
    expect(await readdir(join(dir, 'cache'))).toEqual(['models.json']);
  });

  it('a new catalog instance serves a fresh disk cache without fetching', async () => {
    const first = fakeProvider([[A, B]]);
    await createModelCatalog({ provider: first.provider, cacheFile, now }).list();
    clock += 10 * 60 * 1000;
    const second = fakeProvider([new ProviderError('no_api_key', 'no key')]);
    const cat = createModelCatalog({ provider: second.provider, cacheFile, now });
    expect(await cat.list()).toEqual([A, B]);
    expect(second.calls).toBe(0);
  });

  it('serves the stale cache (disk or memory) when the fetch fails', async () => {
    const first = fakeProvider([[A]]);
    await createModelCatalog({ provider: first.provider, cacheFile, now }).list();
    clock += MODEL_CACHE_TTL_MS + 1;

    const failing = fakeProvider([new ProviderError('network_error', 'offline', true)]);
    const cat = createModelCatalog({ provider: failing.provider, cacheFile, now });
    expect(await cat.list()).toEqual([A]); // stale from disk
    expect(await cat.list({ refresh: true })).toEqual([A]); // refresh failure → stale from memory
    expect(failing.calls).toBe(2);
  });

  it('throws the ProviderError when the fetch fails and nothing is cached', async () => {
    const p = fakeProvider([new ProviderError('no_api_key', 'no key')]);
    const cat = createModelCatalog({ provider: p.provider, cacheFile, now });
    await expect(cat.list()).rejects.toMatchObject({ code: 'no_api_key' });
  });

  it('resetFailure lets the next call fetch again (e.g. after the API key was saved)', async () => {
    const p = fakeProvider([new ProviderError('no_api_key', 'no key'), [A]]);
    const cat = createModelCatalog({ provider: p.provider, cacheFile, now });
    await expect(cat.list()).rejects.toMatchObject({ code: 'no_api_key' });
    cat.resetFailure();
    expect(await cat.list()).toEqual([A]);
  });

  it('backs off after a failure instead of hitting the network on every call', async () => {
    const p = fakeProvider([new ProviderError('network_error', 'offline', true), [A]]);
    const cat = createModelCatalog({ provider: p.provider, cacheFile, now });
    await expect(cat.list()).rejects.toMatchObject({ code: 'network_error' });
    await expect(cat.list()).rejects.toMatchObject({ code: 'network_error' });
    expect(p.calls).toBe(1);
    clock += MODEL_FETCH_BACKOFF_MS;
    expect(await cat.list()).toEqual([A]);
    expect(p.calls).toBe(2);
  });

  it('refresh bypasses the backoff', async () => {
    const p = fakeProvider([new ProviderError('network_error', 'offline', true), [A]]);
    const cat = createModelCatalog({ provider: p.provider, cacheFile, now });
    await expect(cat.list()).rejects.toBeInstanceOf(ProviderError);
    expect(await cat.list({ refresh: true })).toEqual([A]);
  });

  it('ignores a corrupt or malformed cache file', async () => {
    await rm(join(dir, 'cache'), { recursive: true, force: true });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'cache'));
    for (const junk of ['{not json', '{"fetchedAt":"2026-10-31T12:00:00Z","models":[{"id":1}]}', '[]']) {
      await writeFile(cacheFile, junk);
      const p = fakeProvider([[A]]);
      expect(await createModelCatalog({ provider: p.provider, cacheFile, now }).list()).toEqual([A]);
      expect(p.calls).toBe(1);
    }
  });

  it('still returns the models when the cache cannot be written', async () => {
    // `cache` is a regular file, so mkdir/open under it fails.
    await writeFile(join(dir, 'cache'), 'x');
    const p = fakeProvider([[A]]);
    expect(await createModelCatalog({ provider: p.provider, cacheFile, now }).list()).toEqual([A]);
  });

  it('forwards the abort signal and does not mask an abort with stale data', async () => {
    const ac = new AbortController();
    const first = fakeProvider([[A]]);
    const cat = createModelCatalog({ provider: first.provider, cacheFile, now });
    await cat.list();
    expect(await cat.list({ refresh: true, signal: ac.signal })).toEqual([A]);
    expect(first.signals.at(-1)).toBe(ac.signal);

    const abortErr = new DOMException('aborted', 'AbortError');
    const aborting = fakeProvider([abortErr]);
    const cat2 = createModelCatalog({ provider: aborting.provider, cacheFile, now });
    ac.abort();
    await expect(cat2.list({ refresh: true, signal: ac.signal })).rejects.toBe(abortErr);
  });

  describe('get', () => {
    it('returns the known model', async () => {
      const p = fakeProvider([[A, B]]);
      const cat = createModelCatalog({ provider: p.provider, cacheFile, now });
      expect(await cat.get('b/two')).toEqual(B);
    });

    it('unknown id → tools yes, images no, name = id', async () => {
      const p = fakeProvider([[A]]);
      const cat = createModelCatalog({ provider: p.provider, cacheFile, now });
      expect(await cat.get('x/unknown')).toEqual({
        id: 'x/unknown',
        name: 'x/unknown',
        contextLength: null,
        supportsTools: true,
        supportsImages: false,
        promptPricePerMTok: null,
        completionPricePerMTok: null,
      });
    });

    it('never throws, even with no cache and a failing provider', async () => {
      const p = fakeProvider([new Error('boom')]);
      const cat = createModelCatalog({ provider: p.provider, cacheFile, now });
      expect(await cat.get('x/y')).toMatchObject({ id: 'x/y', supportsTools: true, supportsImages: false });
    });
  });
});
