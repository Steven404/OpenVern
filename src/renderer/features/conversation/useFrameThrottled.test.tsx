import { act, cleanup, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFrameThrottled } from './Markdown';

// Manual animation-frame clock.
let frames: Array<{ id: number; cb: () => void } | null> = [];
const runFrames = () => {
  const due = frames;
  frames = [];
  for (const f of due) f?.cb();
};

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    frames.push({ id: frames.length, cb });
    return frames.length - 1;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames[id] = null;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useFrameThrottled', () => {
  it('updates at most once per frame while enabled, and passes the value straight through otherwise', () => {
    const { result, rerender } = renderHook(({ v, on }) => useFrameThrottled(v, on), {
      initialProps: { v: 'a', on: true },
    });
    rerender({ v: 'ab', on: true });
    rerender({ v: 'abc', on: true });
    expect(result.current).toBe('a');
    act(runFrames);
    expect(result.current).toBe('abc');
    rerender({ v: 'abcd', on: false });
    expect(result.current).toBe('abcd');
  });

  it('keeps updating under React StrictMode (regression: the cleanup left a stale frame id behind)', () => {
    const { result, rerender } = renderHook(({ v }) => useFrameThrottled(v, true), {
      initialProps: { v: 'a' },
      wrapper: StrictMode,
    });
    rerender({ v: 'ab' });
    act(runFrames);
    expect(result.current).toBe('ab');
    rerender({ v: 'abc' });
    act(runFrames);
    expect(result.current).toBe('abc');
  });
});
