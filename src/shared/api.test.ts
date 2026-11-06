import { describe, expect, it } from 'vitest';
import { createChatBody, retryBody, sendMessageBody, updateChatBody, updateSettingsBody } from './api';
import { LIMITS, REASONING_EFFORTS } from './constants';
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

describe('effort (F3)', () => {
  const send = { text: 'hi', attachmentIds: [], model: 'm' };
  const sendWith = (effort: unknown) => sendMessageBody.safeParse({ ...send, effort });
  const retryWith = (effort: unknown) => retryBody.safeParse({ model: 'm', effort });
  const settingsWith = (lastEffort: unknown) => updateSettingsBody.safeParse({ lastEffort });

  it('rejects values outside the enum in every body, including the wrong case', () => {
    for (const bad of ['bogus', 'NONE']) {
      expect(sendWith(bad).success).toBe(false);
      expect(retryWith(bad).success).toBe(false);
      expect(settingsWith(bad).success).toBe(false);
    }
  });

  it('accepts none and null, and an omitted effort, in sendMessageBody and retryBody', () => {
    for (const effort of ['none', null]) {
      expect(sendWith(effort).success).toBe(true);
      expect(retryWith(effort).success).toBe(true);
    }
    expect(sendMessageBody.safeParse(send).success).toBe(true);
    expect(retryBody.safeParse({ model: 'm' }).success).toBe(true);
  });

  it('accepts none and null, and an omitted lastEffort, in updateSettingsBody', () => {
    expect(settingsWith('none').success).toBe(true);
    expect(settingsWith(null).success).toBe(true);
    expect(updateSettingsBody.safeParse({}).success).toBe(true);
  });

  it.each(REASONING_EFFORTS)('accepts every level in the list (%s) in all three bodies', (effort) => {
    expect(sendWith(effort).success).toBe(true);
    expect(retryWith(effort).success).toBe(true);
    expect(settingsWith(effort).success).toBe(true);
  });

  it('an omitted effort stays absent after parsing, so the loop keeps the stored effort', () => {
    expect(sendMessageBody.parse(send)).not.toHaveProperty('effort');
    expect(retryBody.parse({ model: 'm' })).not.toHaveProperty('effort');
    expect(updateSettingsBody.parse({})).not.toHaveProperty('lastEffort');
    expect(retryBody.parse({ model: 'm', effort: null }).effort).toBeNull();
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
