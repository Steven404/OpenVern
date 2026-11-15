import { TERMINAL } from '@shared/terminal';

/** UTF-8 size of one code point (a lone surrogate is encoded as the replacement character, 3 bytes). */
function utf8Length(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * Splits one xterm `onData` payload (a paste arrives as a single large string) into pieces main accepts. Iteration is
 * by code point, so a surrogate pair or a multi-byte character is never cut in half. Order is preserved.
 */
export function splitTerminalWrite(data: string, maxBytes = TERMINAL.writeMaxBytes): string[] {
  if (data === '') return [];
  const limit = Math.max(1, Math.floor(maxBytes));
  const pieces: string[] = [];
  let piece = '';
  let bytes = 0;
  for (const char of data) {
    const size = utf8Length(char.codePointAt(0) ?? 0);
    if (bytes + size > limit && piece !== '') {
      pieces.push(piece);
      piece = '';
      bytes = 0;
    }
    piece += char;
    bytes += size;
  }
  if (piece !== '') pieces.push(piece);
  return pieces;
}
