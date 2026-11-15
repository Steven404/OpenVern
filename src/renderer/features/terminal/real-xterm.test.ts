import { TERMINAL } from '@shared/terminal';
import { Terminal } from '@xterm/xterm';
import { expect, it } from 'vitest';
import { readTerminalBuffer } from './read';

it('real xterm parses replay and subsequent output without ever opening a DOM element', async () => {
  const term = new Terminal({ cols: 20, rows: 5, scrollback: TERMINAL.scrollbackLines });
  try {
    await new Promise<void>((resolve) =>
      term.write(`12345678901234567890wrapped\r\nsecret sk-or-v1-${'a'.repeat(64)}`, resolve),
    );
    expect(term.element).toBeUndefined();
    const r = readTerminalBuffer(term.buffer.active, {
      chatId: 'a',
      shell: 'zsh',
      cwd: '/',
      cols: 20,
      rows: 5,
      status: { state: 'running' },
    });
    expect(r.text).toBe('12345678901234567890wrapped\nsecret «redacted:sk-or-v1-…»');
    await new Promise<void>((resolve) => term.write('\r\nmore', resolve));
    await new Promise<void>((resolve) => term.write('', resolve));
    expect(readTerminalBuffer(term.buffer.active, r.info).text).toContain('\nmore');
    await new Promise<void>((resolve) => term.write('\x1b[?1049h\x1b[Hvisible alternate screen', resolve));
    expect(readTerminalBuffer(term.buffer.active, r.info).text).toBe('visible alternate screen');
  } finally {
    term.dispose();
  }
});
