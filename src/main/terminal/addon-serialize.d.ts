// Types for the one @xterm/addon-serialize entry main uses. The package's own typings import @xterm/xterm, whose
// typings carry `/// <reference lib="dom"/>`: imported from main, that pulls the DOM lib into the whole node project
// (and, for one, replaces Node's `RequestInit`). Importing the ESM file by path skips them; this is the slice we use.

declare module '@xterm/addon-serialize/lib/addon-serialize.mjs' {
  import type { ITerminalAddon, Terminal } from '@xterm/headless';

  export interface SerializeOptions {
    /** Rows of scrollback to include (all when omitted). */
    scrollback?: number;
    excludeModes?: boolean;
    excludeAltBuffer?: boolean;
  }

  export class SerializeAddon implements ITerminalAddon {
    activate(terminal: Terminal): void;
    dispose(): void;
    serialize(options?: SerializeOptions): string;
  }
}
