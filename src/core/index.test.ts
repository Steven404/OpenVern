import { describe, expect, it } from 'vitest';
import { createCore } from './index';
import { cleanupTempDirs, MemorySecretStore, makeTempDir } from './storage/test-helpers';

cleanupTempDirs();

// T0 stub (terminal plan §4.3): nothing asks yet. T2 replaces it with the real broker.
describe('Core terminal read stub', () => {
  it('answers unavailable and accepts no answer', async () => {
    const core = await createCore({
      dataDir: await makeTempDir(),
      secretStore: new MemorySecretStore(),
      mode: 'dev',
      version: 'test',
    });
    await expect(
      core.terminalReads.request(
        'c1',
        { startLine: 1, count: 10 },
        { emit: () => {}, signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ ok: false, reason: 'unavailable' });
    expect(core.terminalReads.answer('c1', 'r1', { ok: false, reason: 'unavailable' })).toBe(false);
  });
});
