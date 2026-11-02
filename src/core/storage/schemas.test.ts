import type { Chat } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { chatFileSchema } from './schemas';

describe('chatFileSchema', () => {
  it('round-trips an assistant message notice', () => {
    const chat: Chat = {
      id: 'c',
      projectId: null,
      title: 't',
      model: 'm',
      createdAt: 'x',
      updatedAt: 'x',
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
