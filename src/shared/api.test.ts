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
