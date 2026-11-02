// S1-M1 end to end: a project folder that contains the data dir is allowed, but the agent's tools cannot reach
// the data dir (createCore realpaths it and hands it to the tool sandbox).

import { link, readFile, writeFile } from 'node:fs/promises';
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

// Plan K1: secrets in allowed project files never reach the model, the events or the saved chat.
describe('secret redaction in tool output (K1)', () => {
  const MODEL = 'deepseek/deepseek-v3.2';
  // Assembled at runtime so no token-shaped literal sits in the repo.
  const GH = `ghp_${'aB1'.repeat(12)}`;
  const OR = `sk-or-v1-${'0a1b2c3d'.repeat(8)}`;

  function toolTurn(calls: { name: string; args: unknown }[]) {
    return scriptFromTurns([
      [
        ...calls.map((c, i) => ({
          type: 'tool_call' as const,
          call: { id: `call_${i}`, name: c.name, argsJson: JSON.stringify(c.args) },
        })),
        { type: 'finish', reason: 'tool_calls' },
      ],
      [...textDeltas('done'), { type: 'finish', reason: 'stop' }],
    ]);
  }

  async function runChat(projectDir: string, text = 'go') {
    const project = (await (
      await h.call('/api/projects', { method: 'POST', json: { rootPath: projectDir } })
    ).json()) as Project;
    const chat = (await (
      await h.call('/api/chats', { method: 'POST', json: { projectId: project.id, model: MODEL } })
    ).json()) as Chat;
    const res = await h.call(`/api/chats/${chat.id}/messages`, {
      method: 'POST',
      json: { text, attachmentIds: [], model: MODEL },
    });
    const events = await collectEvents(res);
    const results = events.filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result');
    const everything = JSON.stringify({
      events,
      chat: await h.core.chats.get(chat.id),
      requests: h.provider.calls,
    });
    return { results, everything, chatId: chat.id };
  }

  it('redacts vendor keys read from allowed files, in events, the saved chat and the next request', async () => {
    h = await createHarness({
      script: toolTurn([
        { name: 'read_file', args: { path: 'config.local.json' } },
        { name: 'read_file', args: { path: '.envrc' } },
        { name: 'search', args: { query: 'token' } },
      ]),
    });
    await writeFile(path.join(h.projectDir, 'config.local.json'), `{\n  "token": "${GH}"\n}\n`);
    await writeFile(path.join(h.projectDir, '.envrc'), `export OPENROUTER_API_KEY=${OR}\nexport X=1\n`);

    const { results, everything } = await runChat(h.projectDir);
    expect(results).toHaveLength(3);
    expect(results[0]?.message.output).toContain('"token": "«redacted:ghp_…»"');
    expect(results[0]?.message.output).toContain('replaced with «redacted:…» placeholders');
    expect(results[1]?.message.output).toMatch(
      /1 \| export OPENROUTER_API_KEY=«redacted:sk-or-v1-…»\n\s*2 \| export X=1/,
    );
    expect(results[2]?.message.output).toContain('config.local.json:2:');
    expect(everything).not.toContain(GH);
    expect(everything).not.toContain(OR);
    // The follow-up request carried the redacted tool results.
    expect(JSON.stringify(h.provider.calls[1]?.messages)).toContain('«redacted:ghp_…»');
  });

  it('search cannot probe a secret one character at a time', async () => {
    h = await createHarness({
      script: toolTurn([
        { name: 'search', args: { query: OR.slice(0, 12) } },
        { name: 'search', args: { query: `${GH.slice(0, 6)}.`, is_regex: true } },
      ]),
    });
    await writeFile(path.join(h.projectDir, 'keys.txt'), `${OR}\n${GH}\n`);

    const { results, everything } = await runChat(h.projectDir);
    for (const r of results) expect(r.message.output).toMatch(/^No matches/);
    expect(everything).not.toContain(OR.slice(9, 25));
    expect(everything).not.toContain(GH.slice(4, 20));
  });

  it.skipIf(process.platform === 'win32')('blocks a hardlink of secrets.json under an allowed name', async () => {
    h = await createHarness({
      script: toolTurn([
        { name: 'read_file', args: { path: 'notes.txt' } },
        { name: 'search', args: { query: 'openrouter' } },
      ]),
    });
    await h.core.settings.setApiKey(KEY);
    await link(path.join(h.dataDir, 'secrets.json'), path.join(h.projectDir, 'notes.txt'));

    const { results, everything } = await runChat(h.projectDir);
    expect(results[0]?.message).toMatchObject({ ok: false, output: BLOCKED_MESSAGE });
    expect(results[1]?.message.output).toMatch(/^No matches/);
    expect(everything).not.toContain(KEY);
  });

  it.skipIf(process.platform === 'win32')(
    'scrubs the stored key from a stale copy the inode check cannot see',
    async () => {
      h = await createHarness({ script: toolTurn([{ name: 'read_file', args: { path: 'notes.txt' } }]) });
      await h.core.settings.setApiKey(KEY);
      await link(path.join(h.dataDir, 'secrets.json'), path.join(h.projectDir, 'notes.txt'));
      // Saving again replaces secrets.json (tmp + rename): notes.txt keeps the old inode, with the key still inside.
      await h.core.settings.setApiKey(KEY);

      const { results, everything } = await runChat(h.projectDir);
      expect(results[0]?.message.ok).toBe(true);
      expect(results[0]?.message.output).toContain('«redacted:stored-key»');
      expect(everything).not.toContain(KEY);
    },
  );

  it('scrubs tool output saved before redaction existed when it is replayed', async () => {
    h = await createHarness({ script: scriptFromTurns([[...textDeltas('ok'), { type: 'finish', reason: 'stop' }]]) });
    const project = (await (
      await h.call('/api/projects', { method: 'POST', json: { rootPath: h.projectDir } })
    ).json()) as Project;
    const chat = (await (
      await h.call('/api/chats', { method: 'POST', json: { projectId: project.id, model: MODEL } })
    ).json()) as Chat;
    const at = new Date().toISOString();
    await h.core.chats.appendMessage(chat.id, {
      id: 'u1',
      role: 'user',
      createdAt: at,
      text: 'read it',
      attachments: [],
    });
    await h.core.chats.appendMessage(chat.id, {
      id: 'a1',
      role: 'assistant',
      createdAt: at,
      model: MODEL,
      text: '',
      toolCalls: [{ id: 'c1', name: 'read_file', argsJson: '{"path":"x"}' }],
      status: 'complete',
    });
    await h.core.chats.appendMessage(chat.id, {
      id: 't1',
      role: 'tool',
      createdAt: at,
      toolCallId: 'c1',
      name: 'read_file',
      ok: true,
      output: `x (lines 1-1 of 1)\n1 | ${OR}`,
      summary: 'x',
      durationMs: 1,
    });

    await collectEvents(
      await h.call(`/api/chats/${chat.id}/messages`, {
        method: 'POST',
        json: { text: 'again', attachmentIds: [], model: MODEL },
      }),
    );
    const sent = JSON.stringify(h.provider.calls[0]?.messages);
    expect(sent).toContain('«redacted:sk-or-v1-…»');
    expect(sent).not.toContain(OR);
  });
});
