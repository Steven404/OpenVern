import type { ModelInfo } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { buildIdentity, trimDescription } from './identity';
import { buildSystemPrompt } from './system-prompt';

const base: Omit<ModelInfo, 'id' | 'name'> = {
  contextLength: null,
  supportsTools: true,
  supportsImages: false,
  promptPricePerMTok: null,
  completionPricePerMTok: null,
};

describe('buildIdentity', () => {
  it('DeepSeek: name, id, maker, app, version and description', () => {
    const s = buildIdentity(
      {
        ...base,
        id: 'deepseek/deepseek-chat-v3.1',
        name: 'DeepSeek: DeepSeek V3.1',
        author: 'DeepSeek',
        description: 'A strong [general](https://x.io) model, see https://deepseek.com for more.',
      },
      '0.2.0',
    );
    expect(s).toContain(
      'You are DeepSeek V3.1 (deepseek/deepseek-chat-v3.1), made by DeepSeek, running inside OpenVern v0.2.0',
    );
    expect(s).toContain('OpenVern is the app, not your name');
    expect(s).toContain('A strong general model, see for more.');
    expect(s).not.toContain('http');
  });

  it('Claude via the slug map when author is missing and the name has no prefix', () => {
    const s = buildIdentity({ ...base, id: 'anthropic/claude-sonnet-4.5', name: 'claude-sonnet-4.5' }, '1.0.0');
    expect(s).toContain('made by Anthropic');
  });

  it('unknown model: slug as maker, no strengths', () => {
    const s = buildIdentity({ ...base, id: 'acme/thing-1', name: 'acme/thing-1' }, '0.2.0');
    expect(s).toContain('You are acme/thing-1 (acme/thing-1), made by acme');
    expect(s).toContain('no details about this model');
  });

  it('openrouter/auto: says requests are routed', () => {
    const s = buildIdentity({ ...base, id: 'openrouter/auto', name: 'Auto Router' }, '0.2.0');
    expect(s).toContain('made by OpenRouter');
    expect(s).toContain('routed by OpenRouter');
    expect(s).toContain('may vary');
  });

  it('trims long descriptions to about 500 chars', () => {
    const t = trimDescription('word '.repeat(300));
    expect(t.length).toBeLessThanOrEqual(501);
    expect(t.endsWith('…')).toBe(true);
  });

  it('appears in both the loose and the project prompt', () => {
    const identity = buildIdentity({ ...base, id: 'deepseek/x', name: 'DeepSeek: X' }, '0.2.0');
    const now = new Date(2026, 0, 1);
    const loose = buildSystemPrompt({ identity, now, hasTools: false });
    const proj = buildSystemPrompt({ identity, now, hasTools: true, project: { name: 'p', rootPath: '/p' } });
    expect(loose).toContain(identity);
    expect(proj).toContain(identity);
  });
});
