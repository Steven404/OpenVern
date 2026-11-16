// Quitting ends the terminals once and refuses opens meanwhile; a cancelled quit lets them open again (T1 review
// item 9). Electron's `before-quit` and `will-prevent-unload` are stood in for by direct calls.

import { describe, expect, it, vi } from 'vitest';
import { createQuitGuard } from './quit';

function setup() {
  let finishDispose: () => void = () => {};
  const terminals = {
    beginShutdown: vi.fn(),
    endShutdown: vi.fn(),
    disposeAll: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDispose = resolve;
        }),
    ),
  };
  const quit = vi.fn();
  const guard = createQuitGuard({ terminals, quit });
  const event = () => ({ preventDefault: vi.fn() });
  return { terminals, quit, guard, event, finish: () => finishDispose() };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createQuitGuard', () => {
  it('holds the first quit, refuses opens, ends the terminals, then quits for real', async () => {
    const { terminals, quit, guard, event, finish } = setup();
    const first = event();
    guard.beforeQuit(first);
    expect(first.preventDefault).toHaveBeenCalled();
    expect(terminals.beginShutdown).toHaveBeenCalled();
    expect(terminals.disposeAll).toHaveBeenCalledTimes(1);
    // A second quit while they are ending is held too, without ending them twice.
    const again = event();
    guard.beforeQuit(again);
    expect(again.preventDefault).toHaveBeenCalled();
    expect(terminals.disposeAll).toHaveBeenCalledTimes(1);

    finish();
    await flush();
    expect(quit).toHaveBeenCalledTimes(1);
    const final = event();
    guard.beforeQuit(final);
    expect(final.preventDefault).not.toHaveBeenCalled();
    expect(terminals.endShutdown).not.toHaveBeenCalled();
  });

  it('a window opened while the terminals are being ended does not let opens through', async () => {
    const { terminals, quit, guard, event, finish } = setup();
    guard.beforeQuit(event());
    guard.windowOpening(); // the app was activated again mid-quit
    expect(terminals.endShutdown).not.toHaveBeenCalled();

    finish();
    await flush();
    expect(quit).toHaveBeenCalledTimes(1);
    guard.windowOpening(); // and again, while the resumed quit is closing windows
    expect(terminals.endShutdown).not.toHaveBeenCalled();
    const final = event();
    guard.beforeQuit(final);
    expect(final.preventDefault).not.toHaveBeenCalled();
  });

  it('an unload prevented while the terminals are being ended does not let opens through', async () => {
    const { terminals, quit, guard, event, finish } = setup();
    guard.beforeQuit(event());
    guard.quitCancelled(); // unrelated to the quit, which is on hold
    expect(terminals.endShutdown).not.toHaveBeenCalled();
    finish();
    await flush();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('a window opened when no quit is under way lets opens through', () => {
    const { terminals, guard } = setup();
    guard.windowOpening();
    expect(terminals.endShutdown).toHaveBeenCalledTimes(1);
  });

  it('after a cancelled quit, opens are allowed and the next quit ends the terminals again', async () => {
    const { terminals, guard, event, finish } = setup();
    guard.beforeQuit(event());
    finish();
    await flush();
    guard.beforeQuit(event()); // the real quit: windows start closing
    guard.quitCancelled(); // the page's unload handler kept the window open
    expect(terminals.endShutdown).toHaveBeenCalledTimes(1);

    const next = event();
    guard.beforeQuit(next);
    expect(next.preventDefault).toHaveBeenCalled();
    expect(terminals.disposeAll).toHaveBeenCalledTimes(2);
  });

  it('a new window allows opens again', () => {
    const { terminals, guard } = setup();
    guard.windowOpening();
    expect(terminals.endShutdown).toHaveBeenCalledTimes(1);
  });
});
