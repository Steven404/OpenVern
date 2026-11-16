import { describe, expect, it } from 'vitest';
import { createCore } from './index';
import { cleanupTempDirs, MemorySecretStore, makeTempDir } from './storage/test-helpers';

cleanupTempDirs();

// Terminal plan §4.3: T0 shipped a stub here that answered unavailable at once; T2 replaced it with the real broker,
// so `createCore` relays a read through the run's stream and takes its answer once.
describe('Core terminal reads', () => {
  const core = () =>
    makeTempDir().then((dataDir) =>
      createCore({ dataDir, secretStore: new MemorySecretStore(), mode: 'dev', version: 'test' }),
    );

  it('emits the request and resolves with the answer, which it accepts once', async () => {
    const c = await core();
    let requestId = '';
    const read = c.terminalReads.request(
      'c1',
      { startLine: 1, count: 10 },
      {
        emit: (event) => {
          if (event.type === 'terminal_read_request') requestId = event.requestId;
        },
        signal: new AbortController().signal,
      },
    );
    expect(requestId).not.toBe('');
    expect(c.terminalReads.answer('c1', requestId, { ok: false, reason: 'no_terminal' })).toBe(true);
    expect(c.terminalReads.answer('c1', requestId, { ok: false, reason: 'unavailable' })).toBe(false);
    await expect(read).resolves.toEqual({ ok: false, reason: 'no_terminal' });
  });

  it('refuses an unknown id and answers unavailable when the run stops', async () => {
    const c = await core();
    expect(c.terminalReads.answer('c1', 'r1', { ok: false, reason: 'unavailable' })).toBe(false);
    const controller = new AbortController();
    const read = c.terminalReads.request('c1', {}, { emit: () => {}, signal: controller.signal });
    controller.abort();
    await expect(read).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });
});
