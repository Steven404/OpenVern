import { describe, expect, it } from 'vitest';
import {
  CHAT_PROJECT_CHANGED,
  createChatBody,
  EDIT_MODE_CHANGED,
  ROUTES,
  retryBody,
  sendMessageBody,
  terminalReadAnswerBody,
  undoBatchBody,
  updateChatBody,
  updateSettingsBody,
} from './api';
import { LIMITS, REASONING_EFFORTS } from './constants';
import { ERROR_DEFAULTS, ERROR_STATUS, errorInfo, isApiErrorBody } from './errors';
import { TERMINAL } from './terminal';

describe('api schemas', () => {
  it('validates edit modes on create and update', () => {
    for (const editMode of ['review', 'auto']) {
      expect(createChatBody.parse({ projectId: null, model: 'm', editMode }).editMode).toBe(editMode);
      expect(updateChatBody.parse({ editMode }).editMode).toBe(editMode);
    }
    for (const editMode of ['bogus', '', null, 1]) {
      expect(createChatBody.safeParse({ projectId: null, model: 'm', editMode }).success).toBe(false);
      expect(updateChatBody.safeParse({ editMode }).success).toBe(false);
    }
  });

  it('takes an optional expectedEditMode on send, retry and update', () => {
    const send = { text: 'hi', attachmentIds: [], model: 'm' };
    for (const expectedEditMode of ['review', 'auto']) {
      expect(sendMessageBody.parse({ ...send, expectedEditMode }).expectedEditMode).toBe(expectedEditMode);
      expect(retryBody.parse({ model: 'm', expectedEditMode }).expectedEditMode).toBe(expectedEditMode);
      expect(updateChatBody.parse({ projectId: null, expectedEditMode }).expectedEditMode).toBe(expectedEditMode);
    }
    expect('expectedEditMode' in sendMessageBody.parse(send)).toBe(false);
    expect('expectedEditMode' in retryBody.parse({ model: 'm' })).toBe(false);
    expect('expectedEditMode' in updateChatBody.parse({ projectId: null })).toBe(false);
    for (const expectedEditMode of ['bogus', '', null, 1]) {
      expect(sendMessageBody.safeParse({ ...send, expectedEditMode }).success).toBe(false);
      expect(retryBody.safeParse({ model: 'm', expectedEditMode }).success).toBe(false);
      expect(updateChatBody.safeParse({ expectedEditMode }).success).toBe(false);
    }
    expect(EDIT_MODE_CHANGED).toBe("This chat's edit mode changed. Check Review / Auto and send again.");
  });

  it('takes an optional expectedProjectId on update (a project id or null)', () => {
    expect(updateChatBody.parse({ editMode: 'auto', expectedProjectId: 'p1' }).expectedProjectId).toBe('p1');
    expect(updateChatBody.parse({ editMode: 'auto', expectedProjectId: null }).expectedProjectId).toBeNull();
    expect('expectedProjectId' in updateChatBody.parse({ editMode: 'auto' })).toBe(false);
    for (const expectedProjectId of ['', 1, false]) {
      expect(updateChatBody.safeParse({ editMode: 'auto', expectedProjectId }).success).toBe(false);
    }
    expect(CHAT_PROJECT_CHANGED).toBe('This chat moved to another project. Check Review / Auto and try again.');
  });

  it('exposes the undo route and accepts an empty body', () => {
    expect(ROUTES.chatBatchUndo).toBe('/chats/:id/changes/batches/:batchId/undo');
    expect(undoBatchBody.parse({})).toEqual({});
  });

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

describe('terminal (T0)', () => {
  const send = { text: 'hi', attachmentIds: [], model: 'm' };
  const retry = { model: 'm' };

  it('sendMessageBody and retryBody accept terminal true, false and omitted', () => {
    for (const terminal of [true, false]) {
      expect(sendMessageBody.safeParse({ ...send, terminal }).success).toBe(true);
      expect(retryBody.safeParse({ ...retry, terminal }).success).toBe(true);
    }
    expect(sendMessageBody.safeParse(send).success).toBe(true);
    expect(retryBody.safeParse(retry).success).toBe(true);
    expect(sendMessageBody.parse(send)).not.toHaveProperty('terminal');
    expect(retryBody.parse(retry)).not.toHaveProperty('terminal');
  });

  it('sendMessageBody and retryBody reject a non-boolean terminal', () => {
    for (const terminal of ['yes', null, 1]) {
      expect(sendMessageBody.safeParse({ ...send, terminal }).success).toBe(false);
      expect(retryBody.safeParse({ ...retry, terminal }).success).toBe(false);
    }
  });

  // The largest line number a read can name: the scrollback plus one screenful.
  const maxLine = TERMINAL.scrollbackLines + TERMINAL.maxRows;
  const validAnswer = {
    ok: true as const,
    result: {
      info: {
        chatId: 'c1',
        shell: 'zsh',
        cwd: '/Users/me/project',
        cols: TERMINAL.defaultCols,
        rows: TERMINAL.defaultRows,
        status: { state: 'running' as const },
      },
      totalLines: 42,
      startLine: 1,
      endLine: 2,
      text: 'line 1\nline 2',
      truncated: false,
    },
  };
  const withResult = (patch: Record<string, unknown>) => ({
    ...validAnswer,
    result: { ...validAnswer.result, ...patch },
  });
  const withInfo = (patch: Record<string, unknown>) => withResult({ info: { ...validAnswer.result.info, ...patch } });

  it('terminalReadAnswerBody accepts a success answer', () => {
    expect(terminalReadAnswerBody.safeParse(validAnswer).success).toBe(true);
    expect(terminalReadAnswerBody.parse(validAnswer)).toEqual(validAnswer);
    expect(
      terminalReadAnswerBody.safeParse(withInfo({ status: { state: 'exited', exitCode: 1, signal: null } })).success,
    ).toBe(true);
    expect(
      terminalReadAnswerBody.safeParse(withInfo({ status: { state: 'exited', exitCode: null, signal: 15 } })).success,
    ).toBe(true);
  });

  it('terminalReadAnswerBody accepts both failure reasons', () => {
    for (const reason of ['no_terminal', 'unavailable'] as const) {
      expect(terminalReadAnswerBody.safeParse({ ok: false, reason }).success).toBe(true);
    }
  });

  it('terminalReadAnswerBody rejects an unknown failure reason', () => {
    expect(terminalReadAnswerBody.safeParse({ ok: false, reason: 'timeout' }).success).toBe(false);
    expect(terminalReadAnswerBody.safeParse({ ok: false }).success).toBe(false);
  });

  it('terminalReadAnswerBody rejects an answer with missing fields', () => {
    const { ok: _ok, ...withoutOk } = validAnswer;
    expect(terminalReadAnswerBody.safeParse(withoutOk).success).toBe(false);
    const { result: _result, ...withoutResult } = validAnswer;
    expect(terminalReadAnswerBody.safeParse(withoutResult).success).toBe(false);
    const without = (key: keyof typeof validAnswer.result) => {
      const { [key]: _omit, ...rest } = validAnswer.result;
      return { ...validAnswer, result: rest };
    };
    expect(terminalReadAnswerBody.safeParse(without('text')).success).toBe(false);
    expect(terminalReadAnswerBody.safeParse(without('info')).success).toBe(false);
    expect(terminalReadAnswerBody.safeParse(without('truncated')).success).toBe(false);
  });

  it('terminalReadAnswerBody accepts text up to readWireMaxChars', () => {
    expect(
      terminalReadAnswerBody.safeParse(withResult({ endLine: 1, text: 'x'.repeat(TERMINAL.readWireMaxChars) })).success,
    ).toBe(true);
  });

  it('terminalReadAnswerBody rejects text over readWireMaxChars', () => {
    expect(
      terminalReadAnswerBody.safeParse(withResult({ endLine: 1, text: 'x'.repeat(TERMINAL.readWireMaxChars + 1) }))
        .success,
    ).toBe(false);
  });

  it('terminalReadAnswerBody accepts the empty result and a full readMaxLines range', () => {
    expect(
      terminalReadAnswerBody.safeParse(withResult({ totalLines: 0, startLine: 0, endLine: 0, text: '' })).success,
    ).toBe(true);
    expect(
      terminalReadAnswerBody.safeParse(
        withResult({
          totalLines: TERMINAL.readMaxLines,
          startLine: 1,
          endLine: TERMINAL.readMaxLines,
          text: Array.from({ length: TERMINAL.readMaxLines }, () => 'x').join('\n'),
        }),
      ).success,
    ).toBe(true);
  });

  it('terminalReadAnswerBody rejects text with control characters, and keeps tabs and other scripts', () => {
    for (const bad of ['a\x1b[31mb', 'a\u009b31mb', 'a\rb', 'a\x00b', 'a\x7fb', 'a\u0085b']) {
      expect(terminalReadAnswerBody.safeParse(withResult({ endLine: 1, text: bad })).success).toBe(false);
    }
    for (const ok of ['a\tb', 'γειά 你好 مرحبا', 'e\u0301 👩‍💻', 'right \u202e to left']) {
      expect(terminalReadAnswerBody.safeParse(withResult({ endLine: 1, text: ok })).success).toBe(true);
    }
  });

  it('terminalReadAnswerBody rejects inconsistent line numbers', () => {
    const bad = [
      { startLine: 10, endLine: 5 }, // reversed range
      { totalLines: 42, endLine: 43 }, // range past totalLines
      { totalLines: 2_000, startLine: 1, endLine: TERMINAL.readMaxLines + 1 }, // more than readMaxLines lines
      { startLine: 0, endLine: 5, text: '' }, // startLine 0 with a non-zero endLine
      { startLine: 0, endLine: 0, text: 'x' }, // non-empty text with the 0/0 range
      { startLine: 1, endLine: 1, text: 'a\nb\nc\nd' }, // more lines of text than the range
      { startLine: 1, endLine: 3, text: 'a\nb' }, // fewer lines of text than the range
      { startLine: 1, endLine: 2, text: 'a\nb\n' }, // a trailing line break is an extra line
    ];
    for (const patch of bad) {
      expect(terminalReadAnswerBody.safeParse(withResult(patch)).success).toBe(false);
    }
  });

  it('terminalReadAnswerBody bounds line numbers and sizes', () => {
    for (const field of ['totalLines', 'startLine', 'endLine']) {
      for (const bad of [-1, 1.5, maxLine + 1]) {
        expect(terminalReadAnswerBody.safeParse(withResult({ [field]: bad })).success).toBe(false);
      }
    }
    expect(terminalReadAnswerBody.safeParse(withResult({ totalLines: maxLine })).success).toBe(true);
    expect(
      terminalReadAnswerBody.safeParse(
        withResult({ totalLines: maxLine, startLine: maxLine, endLine: maxLine, text: 'x' }),
      ).success,
    ).toBe(true);
    for (const [field, bad] of [
      ['cols', TERMINAL.minCols - 1],
      ['cols', TERMINAL.maxCols + 1],
      ['cols', TERMINAL.defaultCols + 0.5],
      ['rows', TERMINAL.minRows - 1],
      ['rows', TERMINAL.maxRows + 1],
      ['rows', TERMINAL.defaultRows + 0.5],
    ] as const) {
      expect(terminalReadAnswerBody.safeParse(withInfo({ [field]: bad })).success).toBe(false);
    }
    expect(terminalReadAnswerBody.safeParse(withInfo({ cols: TERMINAL.minCols, rows: TERMINAL.minRows })).success).toBe(
      true,
    );
    expect(terminalReadAnswerBody.safeParse(withInfo({ cols: TERMINAL.maxCols, rows: TERMINAL.maxRows })).success).toBe(
      true,
    );
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
