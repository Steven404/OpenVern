// The main window's lifetime hooks the terminal relies on (docs/terminal-plan.md T1.6): closing, a prevented unload,
// and the renderer process going away. Electron is mocked; the handlers are fired by hand.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  class FakeEmitter {
    readonly handlers = new Map<string, Handler[]>();
    on(event: string, handler: Handler) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }
    once(event: string, handler: Handler) {
      return this.on(event, handler);
    }
    fire(event: string, ...args: unknown[]) {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
  }
  class FakeWebContents extends FakeEmitter {
    setWindowOpenHandler() {}
  }
  const windows: FakeWindow[] = [];
  class FakeWindow extends FakeEmitter {
    readonly webContents = new FakeWebContents();
    constructor() {
      super();
      windows.push(this);
    }
    isDestroyed() {
      return false;
    }
    loadURL() {
      return Promise.resolve();
    }
    show() {}
  }
  return { windows, FakeWindow };
});

vi.mock('electron', () => ({
  app: { getAppPath: () => '/nowhere', isPackaged: true },
  BrowserWindow: mocks.FakeWindow,
  shell: { openExternal: vi.fn() },
}));

import { createMainWindow, getMainWindow } from './window';

describe('createMainWindow lifetime hooks', () => {
  beforeEach(() => {
    mocks.windows.length = 0;
  });

  it('reports a renderer process that is gone, and nothing else, through onRendererGone', () => {
    const onClosed = vi.fn();
    const onUnloadPrevented = vi.fn();
    const onRendererGone = vi.fn();
    createMainWindow({ onClosed, onUnloadPrevented, onRendererGone });
    const win = mocks.windows[0];
    if (!win) throw new Error('no window created');

    win.webContents.fire('render-process-gone', {}, { reason: 'crashed', exitCode: 11 });
    expect(onRendererGone).toHaveBeenCalledTimes(1);
    expect(onClosed).not.toHaveBeenCalled();
    expect(onUnloadPrevented).not.toHaveBeenCalled();

    // A reload is a navigation of the same page: no hook fires.
    win.webContents.fire('did-finish-load');
    expect(onRendererGone).toHaveBeenCalledTimes(1);
  });

  it('reports a prevented unload and the close', () => {
    const onClosed = vi.fn();
    const onUnloadPrevented = vi.fn();
    createMainWindow({ onClosed, onUnloadPrevented });
    const win = mocks.windows[0];
    if (!win) throw new Error('no window created');

    win.webContents.fire('will-prevent-unload', { preventDefault: vi.fn() });
    expect(onUnloadPrevented).toHaveBeenCalledTimes(1);
    expect(getMainWindow()).toBe(win);
    win.fire('closed');
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(getMainWindow()).toBeNull();
  });

  it('works without any hooks', () => {
    createMainWindow();
    const win = mocks.windows[0];
    if (!win) throw new Error('no window created');
    expect(() => win.webContents.fire('render-process-gone', {}, { reason: 'oom', exitCode: 0 })).not.toThrow();
  });
});
