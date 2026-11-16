// How quitting ends the terminals (plan §2, "App lifetime" and "Ending a terminal"), apart from Electron so it can be
// tested. The first `before-quit` is held: opens are refused, every terminal's shell is ended, then the quit is
// started again and goes through. A quit that is cancelled after that (the page's unload handler keeps the window
// open) must not leave opens refused for good, so `quitCancelled` lets them through again and makes the next quit end
// the terminals again.

import type { TerminalManager } from './manager';

export interface QuitGuardDeps {
  terminals: Pick<TerminalManager, 'beginShutdown' | 'endShutdown' | 'disposeAll'>;
  /** Starts the quit again (`app.quit`). */
  quit: () => void;
}

export interface QuitGuard {
  /** For `app.on('before-quit')`. */
  beforeQuit(event: { preventDefault(): void }): void;
  /** The quit or window close was cancelled (Electron's `will-prevent-unload`). */
  quitCancelled(): void;
  /** A main window is being opened (again): opens are allowed, unless a quit is under way. */
  windowOpening(): void;
}

export function createQuitGuard({ terminals, quit }: QuitGuardDeps): QuitGuard {
  let ended = false;
  let ending = false;
  return {
    beforeQuit(event) {
      terminals.beginShutdown();
      if (ended) return;
      event.preventDefault();
      if (ending) return;
      ending = true;
      void terminals.disposeAll().finally(() => {
        ending = false;
        ended = true;
        quit();
      });
    },
    quitCancelled() {
      // While the terminals are still being ended, the quit itself is on hold (the first `before-quit` was prevented),
      // so an unload that was prevented now belongs to something else, such as a reload. Letting opens through here
      // would admit a shell that the quit about to resume never ends.
      if (ending) return;
      ended = false;
      terminals.endShutdown();
    },
    windowOpening() {
      // A window opened while a quit is under way (the app was activated again, or a second instance started) must not
      // lift the refusal: a terminal opened in it would outlive the disposal that has already run or is running. Only
      // a cancelled quit lifts it.
      if (ending || ended) return;
      terminals.endShutdown();
    },
  };
}
