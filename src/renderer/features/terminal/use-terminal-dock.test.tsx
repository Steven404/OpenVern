import { renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ data: [{ id: 'a' }], loads: 0 }));
vi.mock('@renderer/app/queries', () => ({ useChats: () => ({ data: state.data, isFetching: false }) }));
vi.mock('./registry', () => {
  state.loads++;
  return { terminalRegistry: { dispose: vi.fn() } };
});

import { installTerminalBridge } from './test-fakes';
import { useCloseDeletedTerminals } from './use-terminal-dock';

it('does not import the xterm registry when a chat is deleted in the web build', () => {
  installTerminalBridge(null);
  const { rerender } = renderHook(() => useCloseDeletedTerminals());
  state.data = [];
  rerender();
  expect(state.loads).toBe(0);
});
