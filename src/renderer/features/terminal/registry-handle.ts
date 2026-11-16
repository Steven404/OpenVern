// A handle on the terminal registry that does not load it. `./registry` pulls in xterm, so code on the send path (the
// New Chat screen moving its terminal into the chat) must not import it: this module is filled in by `./registry`
// when that loads, and stays empty when no terminal has been shown in this window.
//
// It also keeps the hand-over's hold on new attaches. That lives here, not in the registry, because the registry may
// load while the hand-over runs (the dock opening for the first time) and must find the hold already in place.

import type { Id } from '@shared/types';

/** The parts of a `TerminalEntry` the draft hand-over needs. */
export interface LoadedTerminalEntry {
  pauseRecovery(): { settled: Promise<void>; resume(): void };
}

/** The parts of `TerminalRegistry` the draft hand-over needs. */
export interface LoadedTerminalRegistry {
  settle(id: Id): Promise<LoadedTerminalEntry | undefined>;
  rename(from: Id, to: Id, only?: LoadedTerminalEntry): boolean;
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

interface AttachHold {
  count: number;
  released: Promise<void>;
  release(): void;
}

const holds = new Map<Id, AttachHold>();

/**
 * Keeps every attach of `id` that starts from now on from reaching main until the returned function is called (more
 * than once is harmless). The draft hand-over holds it from before it waits for the attaches already under way until
 * it has renamed the entry: main may have moved the session already, so an `open` sent meanwhile would start a second
 * shell under the old id, and an entry made meanwhile must not be the one renamed. Attaches already under way are not
 * held; `TerminalRegistry.settle` waits for those.
 */
export function holdTerminalAttaches(id: Id): () => void {
  let hold = holds.get(id);
  if (!hold) {
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    hold = { count: 0, released, release };
    holds.set(id, hold);
  }
  hold.count++;
  const held = hold;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    held.count--;
    if (held.count > 0) return;
    if (holds.get(id) === held) holds.delete(id);
    held.release();
  };
}

/** Resolves once nothing holds the attaches of `id`, a hold taken meanwhile included; undefined when none holds them. */
export function terminalAttachesHeld(id: Id): Promise<void> | undefined {
  if (!holds.has(id)) return undefined;
  return (async () => {
    for (let hold = holds.get(id); hold; hold = holds.get(id)) await hold.released;
  })();
}
