import type { Chat } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { chatFileSchema, chatIndexSchema } from './schemas';

describe('chatFileSchema', () => {
  it('round-trips an assistant message notice', () => {
    const chat: Chat = {
      id: 'c',
      projectId: null,
      title: 't',
      model: 'm',
      createdAt: 'x',
      updatedAt: 'x',
      archived: false,
      usage: { contextTokens: 0, promptTokens: 0, completionTokens: 0, costUsd: null, requests: 0 },
      messages: [
        {
          id: 'a',
          role: 'assistant',
          createdAt: 'x',
          model: 'm',
          text: 'hi',
          toolCalls: [],
          status: 'complete',
          notice: 'Heads up',
        },
      ],
    };
    const parsed = chatFileSchema.parse(JSON.parse(JSON.stringify({ version: 1, ...chat })));
    expect(parsed.messages[0]).toMatchObject({ notice: 'Heads up' });
  });
});

describe('archived flag in the storage schemas', () => {
  const summary = { id: 'c', projectId: null, title: 't', model: 'm', createdAt: 'x', updatedAt: 'x' };

  it('chatFileSchema: missing -> false, "yes" -> false, true -> true; version is still stripped', () => {
    const file = { version: 1, ...summary, messages: [] };
    const missing = chatFileSchema.parse(file);
    expect(missing.archived).toBe(false);
    expect(missing).not.toHaveProperty('version');
    expect(chatFileSchema.parse({ ...file, archived: 'yes' }).archived).toBe(false);
    const archived = chatFileSchema.parse({ ...file, archived: true });
    expect(archived.archived).toBe(true);
    expect(archived).not.toHaveProperty('version');
    expect(chatFileSchema.parse({ ...file, archived: false }).archived).toBe(false);
  });

  it('chatIndexSchema: missing -> false, "yes" -> false, true -> true', () => {
    const parsed = chatIndexSchema.parse({
      version: 1,
      chats: [
        { ...summary, id: 'a' },
        { ...summary, id: 'b', archived: 'yes' },
        { ...summary, id: 'c', archived: true },
      ],
    });
    expect(parsed.chats.map((c) => c.archived)).toEqual([false, false, true]);
    expect(parsed).toHaveProperty('version', 1);
  });
});
