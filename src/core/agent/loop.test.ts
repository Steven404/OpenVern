import { MAX_AGENT_STEPS, NEW_CHAT_TITLE } from '@shared/constants';
import type { AgentEvent } from '@shared/events';
import type { AssistantMessage, ToolMessage, UserMessage } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { type FakeStep, scriptFromTurns, textDeltas } from '../providers/fake';
import { ProviderError } from '../providers/types';
import { INTERRUPTED_OUTPUT } from './history';
import { createFakeTool, createHarness, MODEL, model, PROJECT, shape } from './test-helpers';

const usage = { type: 'usage', usage: { promptTokens: 10, completionTokens: 5 } } as const;

const reply = (text: string): FakeStep[] => [...textDeltas(text, 5), usage, { type: 'finish', reason: 'stop' }];
const callTools = (calls: [id: string, name: string, argsJson: string][], pre = ''): FakeStep[] => [
  ...textDeltas(pre, 5),
  ...calls.map(([id, name, argsJson]): FakeStep => ({ type: 'tool_call', call: { id, name, argsJson } })),
  { type: 'finish', reason: 'tool_calls' },
];
const TITLE_TURN = reply('"Friendly greeting."\nExtra line');

const find = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
const roles = (h: { messages(): { role: string }[] }) => h.messages().map((m) => m.role);

describe('text only turn', () => {
  it('emits the exact event sequence, persists messages and titles the chat', async () => {
    const h = await createHarness({ script: scriptFromTurns([reply('Hi! How can I help?'), TITLE_TURN]) });
    const events = await h.run();

    expect(shape(events)).toEqual([
      'user_message',
      'assistant_start',
      'text_delta*',
      'assistant_end',
      'chat_updated',
      'chat_updated',
      'done',
    ]);
    const [um] = find(events, 'user_message');
    expect(um?.message).toMatchObject({ role: 'user', text: 'Hello there', attachments: [] });
    const start = find(events, 'assistant_start')[0];
    const deltas = find(events, 'text_delta');
    expect(deltas.every((d) => d.messageId === start?.messageId)).toBe(true);
    expect(deltas.map((d) => d.delta).join('')).toBe('Hi! How can I help?');
    const end = find(events, 'assistant_end')[0]?.message;
    expect(end).toMatchObject({
      id: start?.messageId,
      status: 'complete',
      text: 'Hi! How can I help?',
      toolCalls: [],
      model: MODEL,
      usage: { promptTokens: 10, completionTokens: 5 },
    });

    expect(h.messages()).toEqual([um?.message, end]);
    const updates = find(events, 'chat_updated');
    expect(updates[0]?.chat.title).toBe(NEW_CHAT_TITLE);
    expect(updates[1]?.chat.title).toBe('Friendly greeting');
    expect((await h.chats.get(h.chatId)).title).toBe('Friendly greeting');
    expect(h.agent.isRunning(h.chatId)).toBe(false);
  });

  it('does not retitle a chat that already has a title', async () => {
    const h = await createHarness({ script: scriptFromTurns([reply('Hi'), TITLE_TURN]) });
    await h.chats.update(h.chatId, { title: 'Custom' });
    const events = await h.run();
    expect(shape(events).filter((t) => t === 'chat_updated')).toHaveLength(1);
    expect(h.provider.calls).toHaveLength(1);
    expect((await h.chats.get(h.chatId)).title).toBe('Custom');
  });

  it('requests the title without tools, with maxTokens 30 and the first message', async () => {
    const h = await createHarness({ script: scriptFromTurns([reply('Hi'), TITLE_TURN]) });
    await h.run({ newUserMessage: { text: 'x'.repeat(2000), attachmentIds: [] } });
    const req = h.provider.calls[1];
    expect(req?.tools).toBeUndefined();
    expect(req?.maxTokens).toBe(30);
    expect(req?.model).toBe(MODEL);
    const part = req?.messages[0];
    expect(part?.role === 'user' && part.content[0]).toMatchObject({ type: 'text', text: 'x'.repeat(1000) });
  });

  it('falls back to the first 60 characters when the title request fails', async () => {
    const h = await createHarness({
      script: scriptFromTurns([reply('Hi'), [{ type: 'throw', error: new ProviderError('provider_error', 'boom') }]]),
    });
    const text = 'Please explain how the build pipeline works in great detail, starting from the entry point';
    const events = await h.run({ newUserMessage: { text, attachmentIds: [] } });
    expect(shape(events).at(-1)).toBe('done');
    expect((await h.chats.get(h.chatId)).title).toBe(text.slice(0, 60));
    expect(text.slice(0, 60).length).toBe(60);
  });

  it('falls back when the title request times out', async () => {
    const h = await createHarness({
      titleTimeoutMs: 20,
      script: scriptFromTurns([reply('Hi'), [{ type: 'delay', ms: 60_000 }, ...reply('Too late')]]),
    });
    await h.run({ newUserMessage: { text: 'Short question', attachmentIds: [] } });
    expect((await h.chats.get(h.chatId)).title).toBe('Short question');
  });

  it('switches the chat model when the turn uses another one and announces it', async () => {
    const h = await createHarness({
      script: scriptFromTurns([reply('Hi'), TITLE_TURN]),
      chatModel: 'other/model',
    });
    const events = await h.run();
    expect((await h.chats.get(h.chatId)).model).toBe(MODEL);
    expect(find(events, 'chat_updated')[0]?.chat.model).toBe(MODEL);
  });
});

describe('tool turns', () => {
  it('tool → text: offers tools, runs the tool, feeds the result back', async () => {
    const h = await createHarness({
      script: scriptFromTurns([
        callTools([['c1', 'read_file', '{"path":"README.md"}']], 'Reading. '),
        reply('It is a readme.'),
        TITLE_TURN,
      ]),
    });
    const events = await h.run();

    expect(shape(events)).toEqual([
      'user_message',
      'assistant_start',
      'text_delta*',
      'assistant_end',
      'tool_call',
      'tool_result',
      'assistant_start',
      'text_delta*',
      'assistant_end',
      'chat_updated',
      'chat_updated',
      'done',
    ]);
    const [a1, a2] = find(events, 'assistant_end').map((e) => e.message);
    expect(a1?.toolCalls).toEqual([{ id: 'c1', name: 'read_file', argsJson: '{"path":"README.md"}' }]);
    expect(a2?.toolCalls).toEqual([]);
    const call = find(events, 'tool_call')[0];
    expect(call?.messageId).toBe(a1?.id);
    const result = find(events, 'tool_result')[0]?.message;
    expect(result).toMatchObject({
      toolCallId: 'c1',
      name: 'read_file',
      ok: true,
      output: 'contents of README.md',
      summary: 'README.md',
    });
    expect(result?.durationMs).toBeGreaterThanOrEqual(0);
    expect(roles(h)).toEqual(['user', 'assistant', 'tool', 'assistant']);

    // First request offers the tools and a project system prompt with the tree.
    const first = h.provider.calls[0];
    expect(first?.tools?.map((t) => t.name)).toEqual(['read_file']);
    expect(first?.system).toContain(PROJECT.name);
    expect(first?.system).toContain(PROJECT.rootPath);
    expect(first?.system).toContain('README.md');
    expect(h.renderTreeCalls).toEqual([{ root: PROJECT.rootPath, opts: { depth: 2, maxEntries: 100 } }]);
    // Second request contains assistant(toolCalls) + tool result.
    expect(h.provider.calls[1]?.messages.slice(1)).toEqual([
      { role: 'assistant', text: 'Reading. ', toolCalls: a1?.toolCalls },
      { role: 'tool', toolCallId: 'c1', content: 'contents of README.md' },
    ]);
    const tool = h.tools[0] as ReturnType<typeof createFakeTool>;
    expect(tool.calls[0]?.ctx.projectRoot).toBe(PROJECT.rootPath);
  });

  it('runs two tool calls from one message sequentially, in order', async () => {
    const order: string[] = [];
    const slow = createFakeTool('read_file', async ({ path }) => {
      order.push(`start ${path}`);
      await new Promise((r) => setTimeout(r, path === 'a' ? 20 : 0));
      order.push(`end ${path}`);
      return { ok: true, output: `out ${path}`, summary: path };
    });
    const h = await createHarness({
      tools: [slow],
      script: scriptFromTurns([
        callTools([
          ['c1', 'read_file', '{"path":"a"}'],
          ['c2', 'read_file', '{"path":"b"}'],
        ]),
        reply('Done.'),
        TITLE_TURN,
      ]),
    });
    const events = await h.run();
    expect(shape(events).slice(0, 8)).toEqual([
      'user_message',
      'assistant_start',
      'assistant_end',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'assistant_start',
    ]);
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b']);
    expect(roles(h)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant']);
    expect(h.provider.calls[1]?.messages.slice(2)).toEqual([
      { role: 'tool', toolCallId: 'c1', content: 'out a' },
      { role: 'tool', toolCallId: 'c2', content: 'out b' },
    ]);
  });

  it('unknown tool → ok:false result fed back to the model', async () => {
    const h = await createHarness({
      script: scriptFromTurns([callTools([['c1', 'delete_everything', '{}']]), reply('Sorry.'), TITLE_TURN]),
    });
    const events = await h.run();
    const result = find(events, 'tool_result')[0]?.message;
    expect(result?.ok).toBe(false);
    expect(result?.output).toContain('Unknown tool "delete_everything"');
    expect(result?.output).toContain('read_file');
    expect(shape(events)).toContain('tool_result');
    expect(h.provider.calls[1]?.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'c1' });
    expect(find(events, 'assistant_end').at(-1)?.message.status).toBe('complete');
  });

  it('invalid arguments (bad JSON and wrong shape) → ok:false results', async () => {
    const h = await createHarness({
      script: scriptFromTurns([
        callTools([
          ['c1', 'read_file', '{not json'],
          ['c2', 'read_file', '{"path":42}'],
        ]),
        reply('Fixing.'),
        TITLE_TURN,
      ]),
    });
    const events = await h.run();
    const [r1, r2] = find(events, 'tool_result').map((e) => e.message);
    expect(r1).toMatchObject({ ok: false, summary: 'Invalid arguments' });
    expect(r1?.output).toContain('not valid JSON');
    expect(r2).toMatchObject({ ok: false });
    expect(r2?.output).toContain('"path" must be a string');
    expect((h.tools[0] as ReturnType<typeof createFakeTool>).calls).toHaveLength(1); // the bad JSON never reached the tool
    expect(shape(events).at(-1)).toBe('done');
  });

  it('treats empty arguments as {}', async () => {
    const h = await createHarness({
      script: scriptFromTurns([callTools([['c1', 'read_file', '']]), reply('ok'), TITLE_TURN]),
    });
    await h.run();
    expect((h.tools[0] as ReturnType<typeof createFakeTool>).calls[0]?.args).toEqual({});
  });
});

describe('tools availability', () => {
  it('offers no tools in a loose chat', async () => {
    const h = await createHarness({ project: false, script: scriptFromTurns([reply('Hi'), TITLE_TURN]) });
    await h.run();
    expect(h.provider.calls[0]?.tools).toBeUndefined();
    expect(h.provider.calls[0]?.system).not.toContain('read_file');
    expect(h.renderTreeCalls).toHaveLength(0);
  });

  it('offers no tools when the model does not support them', async () => {
    const h = await createHarness({
      models: [model(MODEL, { tools: false })],
      script: scriptFromTurns([reply('Hi'), TITLE_TURN]),
    });
    await h.run();
    expect(h.provider.calls[0]?.tools).toBeUndefined();
    expect(h.provider.calls[0]?.system).toContain(PROJECT.name);
    expect(h.provider.calls[0]?.system).toContain("can't use tools");
    expect(h.renderTreeCalls).toHaveLength(0);
  });

  it('a hallucinated tool call in a toolless chat gets an ok:false result', async () => {
    const h = await createHarness({
      project: false,
      script: scriptFromTurns([callTools([['c1', 'read_file', '{"path":"x"}']]), reply('Fine.'), TITLE_TURN]),
    });
    const events = await h.run();
    expect(find(events, 'tool_result')[0]?.message.output).toContain('No tools are available');
  });
});

describe('abort', () => {
  it('mid-stream: saves the partial message as stopped, no error event, done last, no title', async () => {
    const h = await createHarness({
      script: scriptFromTurns([
        [...textDeltas('Partial answer that never ', 7), { type: 'delay', ms: 60_000 }, ...reply('x')],
      ]),
    });
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    await h.agent.runTurn({
      chatId: h.chatId,
      newUserMessage: { text: 'Hi', attachmentIds: [] },
      model: MODEL,
      signal: controller.signal,
      emit: (e) => {
        events.push(e);
        if (e.type === 'text_delta') controller.abort();
      },
    });
    expect(shape(events)).toEqual([
      'user_message',
      'assistant_start',
      'text_delta*',
      'assistant_end',
      'chat_updated',
      'done',
    ]);
    const end = find(events, 'assistant_end')[0]?.message;
    expect(end?.status).toBe('stopped');
    expect(end?.error).toBeUndefined();
    expect(end?.text).toBe('Partial');
    expect(h.messages().at(-1)).toEqual(end);
    expect((await h.chats.get(h.chatId)).title).toBe(NEW_CHAT_TITLE);
    expect(h.provider.calls).toHaveLength(1);
    expect(h.agent.isRunning(h.chatId)).toBe(false);
  });

  it('via agent.abort(): stops a running turn', async () => {
    const h = await createHarness({ script: scriptFromTurns([[{ type: 'delay', ms: 60_000 }, ...reply('x')]]) });
    const events: AgentEvent[] = [];
    const run = h.run({
      emit: (e) => {
        events.push(e);
        if (e.type === 'assistant_start') h.agent.abort(h.chatId);
      },
    });
    await run;
    expect(shape(events)).toEqual(['user_message', 'assistant_start', 'assistant_end', 'chat_updated', 'done']);
    expect(find(events, 'assistant_end')[0]?.message).toMatchObject({ status: 'stopped', text: '' });
  });

  it('mid-tool: the tool gets the aborted signal; every pending call is persisted as Interrupted', async () => {
    let toolSignal: AbortSignal | undefined;
    const slow = createFakeTool('read_file', ({ path }, ctx) => {
      toolSignal = ctx.signal;
      return new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => resolve({ ok: true, output: `late ${path}`, summary: path }));
      });
    });
    const h = await createHarness({
      tools: [slow],
      script: scriptFromTurns([
        callTools([
          ['c1', 'read_file', '{"path":"a"}'],
          ['c2', 'read_file', '{"path":"b"}'],
        ]),
        reply('Recovered'),
        TITLE_TURN,
      ]),
    });
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    await h.agent.runTurn({
      chatId: h.chatId,
      newUserMessage: { text: 'Hi', attachmentIds: [] },
      model: MODEL,
      signal: controller.signal,
      emit: (e) => {
        events.push(e);
        if (e.type === 'tool_call' && e.toolCall.id === 'c1') setTimeout(() => controller.abort(), 5);
      },
    });

    expect(toolSignal?.aborted).toBe(true);
    expect(shape(events)).toEqual([
      'user_message',
      'assistant_start',
      'assistant_end',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'chat_updated',
      'done',
    ]);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const results = find(events, 'tool_result').map((e) => e.message);
    expect(results.map((r) => [r.toolCallId, r.ok, r.output])).toEqual([
      ['c1', false, INTERRUPTED_OUTPUT],
      ['c2', false, INTERRUPTED_OUTPUT],
    ]);
    expect(roles(h)).toEqual(['user', 'assistant', 'tool', 'tool']);
    expect(h.provider.calls).toHaveLength(1);
    expect(slow.calls).toHaveLength(1); // c2 never started

    // The next turn builds a valid history on top of it.
    await h.run({ newUserMessage: { text: 'Continue', attachmentIds: [] } });
    const history = h.provider.calls[1]?.messages;
    expect(history?.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user']);
    expect(history?.filter((m) => m.role === 'tool')).toEqual([
      { role: 'tool', toolCallId: 'c1', content: INTERRUPTED_OUTPUT },
      { role: 'tool', toolCallId: 'c2', content: INTERRUPTED_OUTPUT },
    ]);
  });
});

describe('errors', () => {
  it('provider error mid-stream: partial message saved as error, then assistant_end, error, done', async () => {
    const err = new ProviderError('rate_limited', 'Slow down.', true, 429);
    const h = await createHarness({
      script: scriptFromTurns([[...textDeltas('Half an ans', 6), { type: 'throw', error: err }]]),
    });
    const events = await h.run();
    expect(shape(events)).toEqual([
      'user_message',
      'assistant_start',
      'text_delta*',
      'assistant_end',
      'error',
      'chat_updated',
      'done',
    ]);
    const end = find(events, 'assistant_end')[0]?.message;
    expect(end).toMatchObject({
      status: 'error',
      text: 'Half an ans',
      error: { code: 'rate_limited', message: 'Slow down.', retryable: true },
    });
    expect(find(events, 'error')[0]?.error).toEqual(end?.error);
    expect(h.messages().at(-1)).toEqual(end);
    expect(h.provider.calls).toHaveLength(1); // no title attempt
  });

  it('error before any output (no_api_key at stream start) still persists an error assistant message', async () => {
    const h = await createHarness({
      script: scriptFromTurns([[{ type: 'throw', error: new ProviderError('no_api_key', 'Add your key.') }]]),
    });
    const events = await h.run();
    expect(shape(events)).toEqual([
      'user_message',
      'assistant_start',
      'assistant_end',
      'error',
      'chat_updated',
      'done',
    ]);
    expect(h.messages().at(-1)).toMatchObject({
      role: 'assistant',
      status: 'error',
      text: '',
      error: { code: 'no_api_key' },
    });
  });

  it('an error in a later step keeps the earlier tool results', async () => {
    const h = await createHarness({
      script: scriptFromTurns([
        callTools([['c1', 'read_file', '{"path":"a"}']]),
        [{ type: 'throw', error: new ProviderError('network_error', 'offline', true) }],
      ]),
    });
    const events = await h.run();
    expect(shape(events)).toEqual([
      'user_message',
      'assistant_start',
      'assistant_end',
      'tool_call',
      'tool_result',
      'assistant_start',
      'assistant_end',
      'error',
      'chat_updated',
      'done',
    ]);
    expect(roles(h)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('non-provider failures become an internal error event, still ending with done', async () => {
    const h = await createHarness({ script: scriptFromTurns([reply('x')]) });
    const events = await h.run({ chatId: 'missing-chat' });
    expect(events).toEqual([
      { type: 'error', error: { code: 'not_found', message: 'Not found.', retryable: false } },
      { type: 'done' },
    ]);
    expect(h.agent.isRunning('missing-chat')).toBe(false);
  });

  it('survives an emit that throws', async () => {
    const h = await createHarness({ script: scriptFromTurns([reply('Hi'), TITLE_TURN]) });
    const seen: string[] = [];
    await expect(
      h.run({
        emit: (e) => {
          seen.push(e.type);
          throw new Error('socket closed');
        },
      }),
    ).resolves.toBeDefined();
    expect(seen.at(-1)).toBe('done');
  });

  it('max steps: stops after MAX_AGENT_STEPS model calls with max_steps_reached', async () => {
    const h = await createHarness({
      script: scriptFromTurns([callTools([['c', 'read_file', '{"path":"a"}']])]),
    });
    const events = await h.run();
    expect(h.provider.calls).toHaveLength(MAX_AGENT_STEPS);
    expect(find(events, 'assistant_start')).toHaveLength(MAX_AGENT_STEPS);
    expect(find(events, 'tool_result')).toHaveLength(MAX_AGENT_STEPS);
    const tail = shape(events).slice(-4);
    expect(tail).toEqual(['tool_result', 'error', 'chat_updated', 'done']);
    expect(find(events, 'error')[0]?.error.code).toBe('max_steps_reached');
    expect((await h.chats.get(h.chatId)).title).toBe(NEW_CHAT_TITLE);
  });
});

describe('retry', () => {
  it('truncates after the last user message and reruns without a user_message event', async () => {
    const h = await createHarness({ script: scriptFromTurns([reply('Second try'), TITLE_TURN]) });
    const user: UserMessage = { id: 'u1', role: 'user', createdAt: 't', text: 'Question', attachments: [] };
    const bad: AssistantMessage = {
      id: 'a1',
      role: 'assistant',
      createdAt: 't',
      model: MODEL,
      text: 'oops',
      toolCalls: [{ id: 'c1', name: 'read_file', argsJson: '{}' }],
      status: 'error',
    };
    const tool: ToolMessage = {
      id: 't1',
      role: 'tool',
      createdAt: 't',
      toolCallId: 'c1',
      name: 'read_file',
      ok: true,
      output: 'old',
      summary: 'old',
      durationMs: 1,
    };
    for (const m of [user, bad, tool]) await h.chats.appendMessage(h.chatId, m);

    const events = await h.run({ newUserMessage: undefined });
    expect(shape(events)).toEqual([
      'assistant_start',
      'text_delta*',
      'assistant_end',
      'chat_updated',
      'chat_updated',
      'done',
    ]);
    expect(roles(h)).toEqual(['user', 'assistant']);
    expect(h.messages()[0]).toEqual(user);
    expect((h.messages()[1] as AssistantMessage).text).toBe('Second try');
    // The provider only saw the original question.
    expect(h.provider.calls[0]?.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Question' }] }]);
    expect((await h.chats.get(h.chatId)).title).toBe('Friendly greeting');
  });

  it('errors when there is nothing to retry', async () => {
    const h = await createHarness({ script: scriptFromTurns([reply('x')]) });
    const events = await h.run({ newUserMessage: undefined });
    expect(events.map((e) => e.type)).toEqual(['error', 'done']);
    expect(find(events, 'error')[0]?.error.code).toBe('invalid_request');
    expect(h.provider.calls).toHaveLength(0);
  });
});

describe('attachments', () => {
  it('binds attachments, inlines text files before the text and sends images to vision models', async () => {
    const h = await createHarness({ script: scriptFromTurns([reply('Seen.'), TITLE_TURN]) });
    const file = h.attachments.add({ name: 'notes.ts', content: 'export const a = 1;', mime: 'text/plain' });
    const img = h.attachments.add({ name: 'shot.png', content: new Uint8Array([1, 2, 3]), kind: 'image' });
    const events = await h.run({ newUserMessage: { text: 'Look at these', attachmentIds: [file.id, img.id] } });

    expect(find(events, 'user_message')[0]?.message.attachments).toEqual([file, img]);
    expect(h.attachments.bound.get(file.id)).toBe(h.chatId);
    expect(h.attachments.bound.get(img.id)).toBe(h.chatId);
    expect(h.provider.calls[0]?.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '<attached_file name="notes.ts">\nexport const a = 1;\n</attached_file>' },
        { type: 'image', mime: 'image/png', base64: 'AQID' },
        { type: 'text', text: 'Look at these' },
      ],
    });
  });

  it('replaces images with an omission note for non-vision models', async () => {
    const h = await createHarness({
      models: [model(MODEL, { tools: true, images: false })],
      script: scriptFromTurns([reply('Cannot see.'), TITLE_TURN]),
    });
    const img = h.attachments.add({ name: 'shot.png', content: new Uint8Array([1, 2, 3]), kind: 'image' });
    await h.run({ newUserMessage: { text: 'What is this?', attachmentIds: [img.id] } });
    expect(h.provider.calls[0]?.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '[Image "shot.png" omitted: the current model does not accept images]' },
        { type: 'text', text: 'What is this?' },
      ],
    });
  });

  it('an unknown attachment id fails the turn before anything is persisted', async () => {
    const h = await createHarness({ script: scriptFromTurns([reply('x')]) });
    const events = await h.run({ newUserMessage: { text: 'Hi', attachmentIds: ['nope'] } });
    expect(events.map((e) => e.type)).toEqual(['error', 'done']);
    expect(h.messages()).toEqual([]);
  });
});

describe('concurrency and back-pressure', () => {
  it('registers the run synchronously and rejects a second run on the same chat with conflict', async () => {
    const h = await createHarness({
      script: scriptFromTurns([[{ type: 'delay', ms: 60_000 }, ...reply('x')]]),
    });
    const events1: AgentEvent[] = [];
    const first = h.run({ emit: (e) => void events1.push(e) });
    expect(h.agent.isRunning(h.chatId)).toBe(true);

    const events2 = await h.run();
    expect(events2).toEqual([
      { type: 'error', error: expect.objectContaining({ code: 'conflict', retryable: false }) },
      { type: 'done' },
    ]);
    expect(h.agent.isRunning(h.chatId)).toBe(true); // the first run is unaffected
    expect(roles(h)).toEqual(['user']); // the second run persisted nothing

    h.agent.abort(h.chatId);
    await first;
    expect(h.agent.isRunning(h.chatId)).toBe(false);
    expect(events1.at(-1)?.type).toBe('done');
  });

  it('runs on different chats in parallel', async () => {
    const h = await createHarness({ script: scriptFromTurns([reply('Hi'), TITLE_TURN]) });
    const other = await h.chats.create({ projectId: null, model: MODEL });
    const [a, b] = await Promise.all([h.run(), h.run({ chatId: other.id })]);
    expect(a.at(-1)?.type).toBe('done');
    expect(b.at(-1)?.type).toBe('done');
    expect(find(a, 'error')).toHaveLength(0);
    expect(find(b, 'error')).toHaveLength(0);
  });

  it('awaits emit: events are delivered in order, one at a time, before runTurn resolves', async () => {
    const h = await createHarness({ script: scriptFromTurns([reply('Hello world!'), TITLE_TURN]) });
    const log: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    await h.run({
      emit: async (e) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        log.push(e.type);
        inFlight--;
      },
    });
    expect(maxInFlight).toBe(1);
    expect(log.at(0)).toBe('user_message');
    expect(log.at(-1)).toBe('done');
    expect(log).toContain('assistant_end');
  });
});
