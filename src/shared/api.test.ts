import { describe, expect, it } from 'vitest';
import { createChatBody, sendMessageBody, updateChatBody } from './api';
import { LIMITS } from './constants';
import { ERROR_DEFAULTS, ERROR_STATUS, errorInfo, isApiErrorBody } from './errors';

describe('api schemas', () => {
  it('sendMessageBody needs text or an attachment', () => {
    expect(sendMessageBody.safeParse({ text: '  ', attachmentIds: [], model: 'm' }).success).toBe(false);
    expect(sendMessageBody.safeParse({ text: '', attachmentIds: ['a'], model: 'm' }).success).toBe(true);
    expect(sendMessageBody.safeParse({ text: 'hi', attachmentIds: [], model: 'm' }).success).toBe(true);
  });

  it('sendMessageBody caps attachments', () => {
    const ids = Array.from({ length: LIMITS.attachmentsPerMessage + 1 }, (_, i) => String(i));
    expect(sendMessageBody.safeParse({ text: 'x', attachmentIds: ids, model: 'm' }).success).toBe(false);
  });

  it('createChatBody accepts a null project', () => {
    expect(createChatBody.parse({ projectId: null, model: 'm' })).toEqual({ projectId: null, model: 'm' });
  });

  it('updateChatBody distinguishes "no change" from "move to no project"', () => {
    expect(updateChatBody.parse({})).toEqual({});
    expect(updateChatBody.parse({ projectId: null })).toEqual({ projectId: null });
  });

  it('updateChatBody accepts archived booleans, alone or with a null project', () => {
    expect(updateChatBody.parse({ archived: true })).toEqual({ archived: true });
    expect(updateChatBody.parse({ archived: false })).toEqual({ archived: false });
    expect(updateChatBody.parse({ projectId: null, archived: true })).toEqual({ projectId: null, archived: true });
    expect(updateChatBody.parse({ projectId: 'p1', archived: false })).toEqual({ projectId: 'p1', archived: false });
  });

  it('updateChatBody rejects non-boolean archived values', () => {
    for (const archived of ['true', null, 1]) {
      expect(updateChatBody.safeParse({ archived }).success).toBe(false);
    }
  });

  it('updateChatBody accepts archived together with a projectId', () => {
    const result = updateChatBody.safeParse({ projectId: 'p1', archived: true });
    expect(result.success).toBe(true);
  });

  it('updateChatBody keeps both fields of a combined body', () => {
    expect(updateChatBody.parse({ projectId: 'p1', archived: true })).toEqual({ projectId: 'p1', archived: true });
  });
});

describe('errors', () => {
  it('has a message and a status for every code', () => {
    expect(Object.keys(ERROR_STATUS).sort()).toEqual(Object.keys(ERROR_DEFAULTS).sort());
  });

  it('builds and recognises error bodies', () => {
    const info = errorInfo('rate_limited');
    expect(info.retryable).toBe(true);
    expect(isApiErrorBody({ error: info })).toBe(true);
    expect(isApiErrorBody({ error: 'nope' })).toBe(false);
  });
});
