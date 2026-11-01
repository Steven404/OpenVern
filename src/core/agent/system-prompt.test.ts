import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, formatDate } from './system-prompt';

const now = new Date(2026, 9, 31, 12, 0, 0);
const project = { name: 'demo', rootPath: '/home/me/demo' };

describe('buildSystemPrompt', () => {
  it('formats the local date', () => {
    expect(formatDate(now)).toBe('2026-10-31');
  });

  it('loose chat: short prompt with date and Markdown, no tool talk', () => {
    const p = buildSystemPrompt({ now, hasTools: false });
    expect(p).toContain('harness');
    expect(p).toContain('2026-10-31');
    expect(p).toContain('Markdown');
    expect(p).not.toContain('read_file');
    expect(p).not.toContain('Project root');
  });

  it('project chat with tools: identity, project, capabilities, rules and tree', () => {
    const p = buildSystemPrompt({ now, project, hasTools: true, tree: 'src/\n  main.ts' });
    expect(p).toContain('coding assistant');
    expect(p).toContain('2026-10-31');
    expect(p).toContain('Project: demo');
    expect(p).toContain('Project root: /home/me/demo');
    for (const t of ['list_files', 'read_file', 'search']) expect(p).toContain(t);
    expect(p).toMatch(/cannot modify files or run commands/);
    expect(p).toMatch(/Read before you claim/);
    expect(p).toMatch(/relative to the project root/);
    expect(p).toContain('Markdown');
    expect(p).toContain('src/\n  main.ts');
  });

  it('project chat without tool support: says it cannot read files but shows the tree', () => {
    const p = buildSystemPrompt({ now, project, hasTools: false, tree: 'src/' });
    expect(p).toContain('Project: demo');
    expect(p).toContain("can't use tools");
    expect(p).toContain('src/');
    expect(p).not.toContain('list_files');
  });
});
