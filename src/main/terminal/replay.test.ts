// Replay equivalence (docs/terminal-plan.md §2, "Replay fidelity"; T1 review item 5). One headless terminal gets a
// stream through the session's output filter; at a cut point a snapshot is taken and replayed into a fresh terminal;
// both then get the rest of the stream; their final screens must be the same. This is what a renderer does after a
// chat switch or a reload.

import { SerializeAddon } from '@xterm/addon-serialize/lib/addon-serialize.mjs';
import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { OutputFilter } from './output-filter';
import { TerminalScreen } from './screen';
import { readScreenInternals } from './xterm-internals';

const SCROLLBACK = 5_000;

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function terminal(cols: number, rows: number): Terminal {
  return new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
}

/** Everything later output can depend on: every cell with its attributes, the cursor, the region and saved cursor. */
function screenState(term: Terminal): unknown {
  const buffer = term.buffer.active;
  const lines: unknown[] = [];
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const cells: unknown[] = [];
    for (let x = 0; x < term.cols; x++) {
      const cell = line.getCell(x);
      if (!cell) continue;
      cells.push([
        cell.getChars(),
        cell.getWidth(),
        cell.getFgColorMode(),
        cell.getFgColor(),
        cell.getBgColorMode(),
        cell.getBgColor(),
        cell.isBold(),
        cell.isInverse(),
        cell.isUnderline(),
      ]);
    }
    lines.push({ text: line.translateToString(true), wrapped: line.isWrapped, cells });
  }
  const internals = readScreenInternals(term);
  return {
    type: buffer.type,
    cursor: [buffer.cursorX, buffer.cursorY, buffer.baseY],
    region: [internals.scrollTop, internals.scrollBottom],
    saved: [internals.savedX, internals.savedY, internals.savedAttributes.getFgColor()],
    modes: term.modes,
    lines,
  };
}

type Snapshotter = 'session' | 'serializer-only';

/**
 * Feeds `stream.slice(0, cut)` as one chunk, snapshots, replays, then feeds the rest to both. `session` uses the real
 * path (filter + TerminalScreen.serialize); `serializer-only` is the old one, to show the test catches its failures.
 */
async function replayAt(stream: string, cut: number, cols: number, rows: number, how: Snapshotter = 'session') {
  const original = terminal(cols, rows);
  const replay = terminal(cols, rows);
  let snapshot: string;
  let rest: string;
  if (how === 'session') {
    const filter = new OutputFilter();
    const screen = new TerminalScreen(cols, rows, SCROLLBACK);
    const before = filter.push(stream.slice(0, cut));
    screen.write(before);
    await write(original, before);
    snapshot = await screen.afterParsed(() => screen.serialize());
    screen.dispose();
    rest = filter.push(stream.slice(cut)) + filter.flush();
  } else {
    const serializer = new SerializeAddon();
    original.loadAddon(serializer);
    await write(original, stream.slice(0, cut));
    snapshot = serializer.serialize({ scrollback: SCROLLBACK });
    rest = stream.slice(cut);
  }
  await write(replay, snapshot);
  await write(original, rest);
  await write(replay, rest);
  const result = { original: screenState(original), replay: screenState(replay) };
  original.dispose();
  replay.dispose();
  return result;
}

const firstLine = (state: unknown) => (state as { lines: { text: string }[] }).lines[0]?.text;

describe('the reviewer’s reproductions', () => {
  it('a snapshot taken between ESC[31 and mR: the replay prints a red R, not a literal m', async () => {
    const stream = 'x \u001b[31mR\u001b[0m';
    const cut = stream.indexOf('m');
    const { original, replay } = await replayAt(stream, cut, 20, 5);
    expect(replay).toStrictEqual(original);
    expect(firstLine(replay)).toBe('x R');

    const old = await replayAt(stream, cut, 20, 5, 'serializer-only');
    expect(firstLine(old.replay)).toBe('x mR');
  });

  it('a saved cursor restored after the snapshot: HELLO!, not !ELLO', async () => {
    const stream = 'HELLO\u001b7\u001b[H\u001b8!';
    const cut = stream.indexOf('\u001b[H');
    const { original, replay } = await replayAt(stream, cut, 20, 5);
    expect(firstLine(original)).toBe('HELLO!');
    expect(replay).toStrictEqual(original);

    const old = await replayAt(stream, cut, 20, 5, 'serializer-only');
    expect(firstLine(old.replay)).toBe('!ELLO');
  });

  it('a scroll region: later output scrolls inside it in the replay too', async () => {
    const stream = 'top\r\n\u001b[2;4r\u001b[4;1Hbottom\u001b[5;1Hstatus\u001b[4;1H\r\na\r\nb\r\nc';
    const cut = stream.indexOf('\r\na');
    const { original, replay } = await replayAt(stream, cut, 20, 5);
    expect(replay).toStrictEqual(original);

    const old = await replayAt(stream, cut, 20, 5, 'serializer-only');
    expect(old.replay).not.toStrictEqual(old.original);
  });
});

// A stream in the style of a full-screen program (vim, less, htop): alternate screen, a scroll region, origin mode,
// DECSC/DECRC, colours, a title, a wide character, combining marks, a write to the last column (pending wrap), and
// scrolling inside the region.
const FULL_SCREEN = [
  'prompt$ vim\r\n',
  '\u001b]0;vim file.txt\u0007',
  '\u001b[?1049h\u001b[H\u001b[2J',
  '\u001b[1;23r',
  '\u001b[38;5;208mline one\u001b[m\r\n',
  '\u001b[1;4;48;2;10;20;30mbold rgb\u001b[0m 中文 é\r\n',
  '\u001b[24;1H\u001b[7m-- INSERT --\u001b[m',
  '\u001b[3;5H\u001b7',
  '\u001b[?6h\u001b[2;1Horigin row 2',
  '\u001b[?6l',
  '\u001b8\u001b[33mrestored\u001b[m',
  '\u001b[10;1H',
  '0123456789012345678901234567890123456789',
  '\u001b[23;1H\r\nscrolled 1\r\nscrolled 2',
  '\u001bP+q544e\u001b\\',
  '\u001b[?25l\u001b[5;1H\u001b[K\u001b[?25h',
  '\u001b[r\u001b[?1049l',
  'back in the shell\r\n',
].join('');

describe('replay at every cut point of a full-screen stream', () => {
  it('gives the same final screen as the original', async () => {
    const differing: number[] = [];
    for (let cut = 0; cut <= FULL_SCREEN.length; cut++) {
      const { original, replay } = await replayAt(FULL_SCREEN, cut, 40, 24);
      try {
        expect(replay).toStrictEqual(original);
      } catch {
        differing.push(cut);
      }
    }
    expect(differing).toStrictEqual([]);
  }, 60_000);

  it('also before the alternate screen is left (the snapshot taken inside the full-screen program)', async () => {
    const inside = FULL_SCREEN.slice(0, FULL_SCREEN.indexOf('\u001b[r\u001b[?1049l'));
    const differing: number[] = [];
    for (let cut = 0; cut <= inside.length; cut += 3) {
      const { original, replay } = await replayAt(inside, cut, 40, 24);
      try {
        expect(replay).toStrictEqual(original);
      } catch {
        differing.push(cut);
      }
    }
    expect(differing).toStrictEqual([]);
  }, 60_000);

  it('leaving the alternate screen restores the pen the shell had, not the one of the snapshot', async () => {
    // A snapshot while vim draws in orange; then vim quits and the shell prints its prompt.
    const stream = '\u001b[?1049h\u001b[38;5;208morange\u001b[?1049l$ ';
    const cut = stream.indexOf('\u001b[?1049l');
    const { original, replay } = await replayAt(stream, cut, 20, 5);
    expect(replay).toStrictEqual(original);
  });

  it('restores a pending wrap in the last column under a scroll region', async () => {
    const stream = `\u001b[1;3r\u001b[3;1H${'x'.repeat(20)}`;
    const { original, replay } = await replayAt(`${stream}Y`, stream.length, 20, 5);
    expect(replay).toStrictEqual(original);
  });
});
