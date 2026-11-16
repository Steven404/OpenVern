import { TERMINAL, type TerminalInfo, type TerminalReadRequest, type TerminalReadResult } from '@shared/terminal';
import { redactTerminalText } from '@shared/terminal-redact';
import { redactBufferLines } from './redact-buffer';

/** Structural subset of xterm's active buffer, also usable with small test doubles. */
export interface ReadBuffer {
  length: number;
  getLine(index: number):
    | {
        isWrapped: boolean;
        translateToString(trimRight?: boolean): string;
        getCell?(column: number): { getChars(): string; getWidth(): number } | undefined;
      }
    | undefined;
}

export function readTerminalBuffer(
  buffer: ReadBuffer,
  info: TerminalInfo,
  request: TerminalReadRequest = {},
): TerminalReadResult {
  for (const value of [request.startLine, request.count]) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1))
      throw new Error('Invalid terminal read request');
  }
  const lines: string[] = [];
  const full: boolean[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const row = buffer.getLine(i);
    if (!row) throw new Error('Missing terminal buffer row');
    // Preserve spaces at wrap boundaries; trim only at the end of the logical line.
    const text = row.translateToString(false);
    if (row.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
    const lastCell = row.getCell?.(info.cols - 1);
    // A wide glyph can occupy the last cell with an empty continuation cell.
    full[lines.length - 1] =
      !!lastCell && ((lastCell.getChars() !== '' && lastCell.getChars() !== ' ') || lastCell.getWidth() === 0);
  }
  const whole = lines.join('\n');
  const redacted = redactTerminalText(redactBufferLines(lines, full, buffer.getLine(0)?.isWrapped ?? false).join('\n'))
    .text.split('\n')
    .map((line) => line.trimEnd());
  if (redacted.length !== whole.split('\n').length) throw new Error('Redaction changed line numbers');
  // totalLines describes the original buffer, including blank lines inside a redacted PEM block.
  while (lines.length && lines.at(-1)?.trimEnd() === '') lines.pop();
  const totalLines = lines.length;
  const count = Math.min(TERMINAL.readMaxLines, request.count ?? TERMINAL.readDefaultLines);
  let startLine = request.startLine ?? Math.max(1, totalLines - count + 1);
  const endLine = Math.min(totalLines, startLine + count - 1);
  if (!totalLines || startLine > totalLines)
    return { info, totalLines, startLine: 0, endLine: 0, text: '', truncated: false };
  const selected = redacted.slice(startLine - 1, endLine);
  let size = selected.join('\n').length;
  let truncated = false;
  while (size > TERMINAL.readWireMaxChars && selected.length > 1) {
    size -= (selected.shift()?.length ?? 0) + 1;
    startLine++;
    truncated = true;
  }
  if (size > TERMINAL.readWireMaxChars) {
    selected[0] = '[Terminal line omitted: too long]';
    truncated = true;
  }
  return { info, totalLines, startLine, endLine, text: selected.join('\n'), truncated };
}
