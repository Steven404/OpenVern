// Moves the New Chat screen's terminal into the chat created from it, on the chat's first send. Main renames the
// session (`adopt`), then the renderer renames its emulator and the dock's open state, so the chat shows the same shell
// and the model's `read_terminal` in the first run finds it, output from before the chat existed included.
//
// Called before navigating to the chat and before the first run. It never throws and never loads xterm: the registry
// is reached through `./registry-handle`, which is empty unless a terminal has already been shown in this window.

import { DRAFT_CHAT_ID } from '@shared/constants';
import type { Id } from '@shared/types';
import { getTerminalBridge } from './bridge';
import { loadedTerminalRegistry } from './registry-handle';
import { useTerminalUiStore } from './terminal-store';

export async function adoptDraftTerminal(chatId: Id): Promise<void> {
  let pause: { settled: Promise<void>; resume(): void } | undefined;
  try {
    const bridge = getTerminalBridge();
    if (!bridge || chatId === DRAFT_CHAT_ID) return;
    // A draft terminal still opening, or still waiting for a free slot before it opens: let it settle first, so main
    // has the session to move (or has refused it).
    const entry = await loadedTerminalRegistry()?.settle(DRAFT_CHAT_ID);
    // No recovery `open` under the draft id while main moves the session; one already sent finishes first.
    pause = entry?.pauseRecovery();
    if (pause) await pause.settled;
    const moved = await bridge.adopt(DRAFT_CHAT_ID, chatId).catch(() => false);
    // Read again: the registry may have loaded meanwhile.
    const registry = loadedTerminalRegistry();
    const store = useTerminalUiStore.getState();
    if (moved === true) {
      registry?.rename(DRAFT_CHAT_ID, chatId);
      store.moveDock(DRAFT_CHAT_ID, chatId);
      store.setDraftProject(undefined);
    } else {
      // Nothing moved: the chat starts without a terminal and the next New Chat starts clean on screen. A draft shell
      // main kept (an `adopt` that failed) is attached again the next time the New Chat screen's dock opens.
      registry?.dispose(DRAFT_CHAT_ID);
      store.closeDock(DRAFT_CHAT_ID);
    }
  } catch {
    // Never in the way of sending the message.
  } finally {
    // After the rename: a recovery held meanwhile asks for the session under the chat's id.
    pause?.resume();
  }
}
