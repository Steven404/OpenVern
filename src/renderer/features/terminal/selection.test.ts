import { TERMINAL } from '@shared/terminal';
import { describe, expect, it } from 'vitest';
import { terminalSelectionBlock } from './selection';

describe('terminalSelectionBlock', () => {
  it('is null for a blank selection', () => {
    expect(terminalSelectionBlock('')).toBeNull();
    expect(terminalSelectionBlock('  \n\t \n')).toBeNull();
  });

  it('wraps the selection in a fenced text block', () => {
    expect(terminalSelectionBlock('npm test')).toBe('```text\nnpm test\n```');
  });

  it('normalises line endings and drops trailing spaces on each line', () => {
    expect(terminalSelectionBlock('ls -la   \r\nfoo\r\n')).toBe('```text\nls -la\nfoo\n```');
  });

  it('uses a longer fence when the output has backticks, so they do not end the block', () => {
    expect(terminalSelectionBlock('```js\ncode\n```')).toBe('````text\n```js\ncode\n```\n````');
  });

  it('redacts secret-looking values with the same placeholders as the tool path', () => {
    const block = terminalSelectionBlock('export KEY=sk-or-v1-abcdef1234');
    expect(block).toBe('```text\nexport KEY=«redacted:sk-or-v1-…»\n```');
    expect(block).not.toContain('abcdef1234');
  });

  it('redacts before it caps, so a key that straddles the cut does not leak its body', () => {
    const cap = TERMINAL.selectionMaxChars;
    // The prefix ends 7 characters before the cap: cutting first would leave `sk-or-v` and lose the match.
    const block = terminalSelectionBlock(`${'z'.repeat(cap - 7)}sk-or-v1-abcdef1234`);
    expect(block).not.toBeNull();
    expect(block).not.toContain('abcdef1234');
    expect(block).not.toContain('sk-or-v1-abcdef');
  });

  it('redacts a key that ends before the cut and then caps the redacted text', () => {
    const block = terminalSelectionBlock(`export KEY=sk-or-v1-abcdef1234\n${'z'.repeat(TERMINAL.selectionMaxChars)}`);
    expect(block).toContain('«redacted:sk-or-v1-…»');
    expect(block).not.toContain('abcdef1234');
    expect(block).toContain('[The selection was cut at');
  });

  it('cuts a selection longer than selectionMaxChars and says so after the block', () => {
    const cap = TERMINAL.selectionMaxChars;
    const block = terminalSelectionBlock('z'.repeat(cap + 500));
    expect(block).toBe(`\`\`\`text\n${'z'.repeat(cap)}\n\`\`\`\n[The selection was cut at ${cap} characters.]`);
  });

  it('does not add the cut note when the selection fits exactly', () => {
    const block = terminalSelectionBlock('z'.repeat(TERMINAL.selectionMaxChars));
    expect(block).not.toContain('was cut');
  });
});
