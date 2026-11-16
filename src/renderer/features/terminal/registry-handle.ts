// A handle on the terminal registry that does not load it. `./registry` pulls in xterm, so code on the send path (the
// New Chat screen moving its terminal into the chat) must not import it: this module is filled in by `./registry`
// when that loads, and stays empty when no terminal has been shown in this window.

import type { Id } from '@shared/types';

/** The parts of `TerminalRegistry` the draft hand-over needs. */
export interface LoadedTerminalRegistry {
  get(id: Id): { ready: Promise<void> } | undefined;
  rename(from: Id, to: Id): boolean;
  dispose(id: Id): void;
}

let loaded: LoadedTerminalRegistry | null = null;

/** Called once by `./registry` as it loads. */
export function setLoadedTerminalRegistry(registry: LoadedTerminalRegistry | null): void {
  loaded = registry;
}

/** The registry if `./registry` has loaded, else null (then no emulator exists in this window). */
export function loadedTerminalRegistry(): LoadedTerminalRegistry | null {
  return loaded;
}
