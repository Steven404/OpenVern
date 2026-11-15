import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@xterm/xterm', () => import('./test-fakes'));
vi.mock('@xterm/addon-fit', () => import('./test-fakes'));

import { MockApiClient } from '@renderer/lib/mock-api-client';
import { relayTerminalRead } from '@renderer/stores/runs';
import { terminalRegistry } from './registry';
import { FakeTerminalBridge } from './test-fakes';

afterEach(() => terminalRegistry.disposeAll());
const request = { requestId: 'request', request: {} };
function setup() {
  const api = new MockApiClient({ delayMs: 0 });
  const post = vi.spyOn(api, 'answerTerminalRead').mockResolvedValue(undefined);
  const bridge = new FakeTerminalBridge();
  const deps = { api, queryClient: new QueryClient(), terminal: bridge };
  return { deps, post, bridge };
}
it('relays reads from existing and reload-restored instances with the original request id', async () => {
  const { deps, post, bridge } = setup();
  bridge.seed('a', { replay: 'restored' });
  await relayTerminalRead(deps, 'a', request);
  expect(post).toHaveBeenCalledWith(
    'a',
    'request',
    expect.objectContaining({ ok: true, result: expect.objectContaining({ text: 'restored' }) }),
  );
  bridge.emitData('a', ' and live');
  await relayTerminalRead(deps, 'a', request);
  expect(post).toHaveBeenLastCalledWith(
    'a',
    'request',
    expect.objectContaining({ ok: true, result: expect.objectContaining({ text: 'restored and live' }) }),
  );
  expect(bridge.opens).toHaveLength(1);
});
it('answers no_terminal when list has no session', async () => {
  const { deps, post } = setup();
  await relayTerminalRead(deps, 'a', request);
  expect(post).toHaveBeenCalledWith('a', 'request', { ok: false, reason: 'no_terminal' });
});
it('answers unavailable without a bridge or when list or open fails', async () => {
  const { deps, post, bridge } = setup();
  await relayTerminalRead({ ...deps, terminal: undefined }, 'a', request);
  expect(post).toHaveBeenLastCalledWith('a', 'request', { ok: false, reason: 'unavailable' });
  const list = bridge.list.bind(bridge);
  bridge.list = async () => {
    throw new Error('list unavailable');
  };
  await relayTerminalRead(deps, 'a', request);
  expect(post).toHaveBeenLastCalledWith('a', 'request', { ok: false, reason: 'unavailable' });
  bridge.list = list;
  bridge.seed('a');
  bridge.open = async () => {
    throw new Error('open unavailable');
  };
  await relayTerminalRead(deps, 'a', request);
  expect(post).toHaveBeenLastCalledWith('a', 'request', { ok: false, reason: 'unavailable' });
  expect(terminalRegistry.get('a')).toBeUndefined();
});
it('ignores a failed answer post', async () => {
  const { deps, post } = setup();
  post.mockRejectedValue(new Error('expired'));
  await expect(relayTerminalRead(deps, 'a', request)).resolves.toBeUndefined();
});
