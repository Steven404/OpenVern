// S1-M1 end to end: a project folder that contains the data dir is allowed, but the agent's tools cannot reach
// the data dir (createCore realpaths it and hands it to the tool sandbox).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentEvent } from '@shared/events';
import type { Chat, Project } from '@shared/types';
import { afterEach, describe, expect, it } from 'vitest';
import { scriptFromTurns, textDeltas } from '../core/providers/fake';
import { BLOCKED_MESSAGE } from '../core/tools/sandbox';
import { collectEvents, createHarness, type Harness } from './test-helpers';

const KEY = 'sk-or-v1-DATADIRSECRET0000';

let h: Harness;
afterEach(async () => {
  await h.cleanup();
});

describe('data dir inside a project (S1-M1)', () => {
  it('read_file of <data>/secrets.json is blocked and the key never reaches the tool result', async () => {
    h = await createHarness({
      script: scriptFromTurns([
        [
          {
            type: 'tool_call',
            call: { id: 'call_1', name: 'read_file', argsJson: JSON.stringify({ path: 'data/secrets.json' }) },
          },
          { type: 'finish', reason: 'tool_calls' },
        ],
        [...textDeltas('done'), { type: 'finish', reason: 'stop' }],
      ]),
    });
    await h.core.settings.setApiKey(KEY);
    expect(await readFile(path.join(h.dataDir, 'secrets.json'), 'utf8')).toContain(KEY);

    const root = path.dirname(h.dataDir);
    const projectRes = await h.call('/api/projects', { method: 'POST', json: { rootPath: root } });
    expect(projectRes.status).toBe(200);
    const project = (await projectRes.json()) as Project;

    const chat = (await (
      await h.call('/api/chats', { method: 'POST', json: { projectId: project.id, model: 'deepseek/deepseek-v3.2' } })
    ).json()) as Chat;
    const res = await h.call(`/api/chats/${chat.id}/messages`, {
      method: 'POST',
      json: { text: 'show me my key', attachmentIds: [], model: 'deepseek/deepseek-v3.2' },
    });
    const events = await collectEvents(res);
    const toolResult = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result');
    expect(toolResult?.message).toMatchObject({ name: 'read_file', ok: false });
    expect(toolResult?.message.output).toContain(BLOCKED_MESSAGE);
    expect(JSON.stringify(events)).not.toContain(KEY);
    expect(JSON.stringify(await h.core.chats.get(chat.id))).not.toContain(KEY);
  });
});
