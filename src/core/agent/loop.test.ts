import { LIMITS, MAX_AGENT_STEPS, NEW_CHAT_TITLE, TREE_UNAVAILABLE_NOTICE } from '@shared/constants';
import type { AgentEvent } from '@shared/events';
import type { AssistantMessage, ToolMessage, UserMessage } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { type FakeStep, scriptFromTurns, textDeltas } from '../providers/fake';
import { ProviderError } from '../providers/types';
import { INTERRUPTED_OUTPUT } from './history';
import { createFakeTool, createHarness, type Harness, MODEL, model, PROJECT, shape } from './test-helpers';

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

  it('a rename made while the title is generated wins', async () => {
    let h!: Harness;
    h = await createHarness({
      script: (_req, i) => {
        if (i === 1) void h.chats.update(h.chatId, { title: 'User rename' });
        return i === 0 ? reply('Hi') : TITLE_TURN;
      },
    });
    const events = await h.run();
    expect((await h.chats.get(h.chatId)).title).toBe('User rename');
    expect(find(events, 'chat_updated')).toHaveLength(1);
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
    expect(h.renderTreeCalls).toEqual([{ root: PROJECT.rootPath, opts: { depth: 2, maxEntries: 100 } }]);
    expect(h.provider.calls[0]?.system).toContain('README.md');
  });

  it('a hallucinated tool call in a toolless chat gets an ok:false result', async () => {
    const h = await createHarness({
      project: false,
      script: scriptFromTurns([callTools([['c1', 'read_file', '{"path":"x"}']]), reply('Fine.'), TITLE_TURN]),
    });
    const events = await h.run();
    expect(find(events, 'tool_result')[0]?.message.output).toContain('No tools are available');
  });

  it('flattens in-turn tool calls into plain text when no tools were offered', async () => {
    const h = await createHarness({
      project: false,
      script: scriptFromTurns([
        callTools([['c1', 'read_file', '{"path":"x"}']], 'Let me look. '),
        reply('Fine.'),
        TITLE_TURN,
      ]),
    });
    const events = await h.run();
    const req = h.provider.calls[1];
    expect(req?.tools).toBeUndefined();
    expect(req?.messages.some((m) => m.role === 'tool')).toBe(false);
    for (const m of req?.messages ?? []) if (m.role === 'assistant') expect(m.toolCalls).toEqual([]);
    const assistants = req?.messages.filter((m) => m.role === 'assistant') ?? [];
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ text: expect.stringContaining('[tool read_file {"path":"x"} → error]') });
    expect(assistants[0]).toMatchObject({ text: expect.stringContaining('Let me look.') });
    expect(find(events, 'tool_call')).toHaveLength(1);
    expect(h.messages().at(-1)).toMatchObject({ role: 'assistant', text: 'Fine.', status: 'complete' });
  });
});

describe('history when tools are no longer offered', () => {
  const script = () =>
    scriptFromTurns([
      callTools([['c1', 'read_file', '{"path":"README.md"}']], 'Reading. '),
      reply('It is a readme.'),
      TITLE_TURN,
      reply('Still here.'),
    ]);

  const check = (h: Harness) => {
    const req = h.provider.calls[3];
    expect(req?.tools).toBeUndefined();
    expect(req?.messages.some((m) => m.role === 'tool')).toBe(false);
    for (const m of req?.messages ?? []) if (m.role === 'assistant') expect(m.toolCalls).toEqual([]);
    expect(req?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hello there' }] },
      {
        role: 'assistant',
        text: 'Reading. \n\n[tool read_file {"path":"README.md"} → ok]\ncontents of README.md\n\nIt is a readme.',
        toolCalls: [],
      },
      { role: 'user', content: [{ type: 'text', text: 'And now?' }] },
    ]);
  };
  const second = { newUserMessage: { text: 'And now?', attachmentIds: [] } };

  it('a tool turn followed by a turn on a non-tool model sends flattened text', async () => {
    const h = await createHarness({
      models: [model(MODEL), model('plain/model', { tools: false })],
      script: script(),
    });
    await h.run();
    await h.run({ ...second, model: 'plain/model' });
    check(h);
  });

  it('a tool turn followed by a turn after the project is detached sends flattened text', async () => {
    const h = await createHarness({ script: script() });
    await h.run();
    await h.chats.detachProject(PROJECT.id);
    await h.run(second);
    check(h);
  });
});

describe('project tree timeout', () => {
  const never = () => new Promise<string>(() => {});

  it('continues without the tree after the timeout, tells the model, and sets the notice on the first message', async () => {
    const h = await createHarness({
      treeTimeoutMs: 20,
      renderTree: never,
      script: scriptFromTurns([callTools([['c1', 'read_file', '{"path":"a"}']]), reply('Done.'), TITLE_TURN]),
    });
    const events = await h.run();
    expect(h.provider.calls[0]?.system).toContain("couldn't be read in time");
    expect(h.provider.calls[0]?.system).not.toContain('Top of the project tree');
    const ends = find(events, 'assistant_end').map((e) => e.message);
    expect(ends[0]?.notice).toBe(TREE_UNAVAILABLE_NOTICE);
    expect(ends[1]?.notice).toBeUndefined();
    expect(h.messages().find((m) => m.role === 'assistant')).toMatchObject({ notice: TREE_UNAVAILABLE_NOTICE });
    expect(find(events, 'error')).toHaveLength(0);
    // the notice is UI-only
    expect(JSON.stringify(h.provider.calls[1]?.messages)).not.toContain('replied without');
  });

  it('has a 2.5 s default timeout', () => {
    expect(LIMITS.systemPromptTreeTimeoutMs).toBe(2500);
  });

  it('a tree that resolves in time sets no notice', async () => {
    const h = await createHarness({ script: scriptFromTurns([reply('Hi'), TITLE_TURN]) });
    await h.run();
    expect(h.messages().find((m) => m.role === 'assistant')).not.toHaveProperty('notice');
    expect(h.provider.calls[0]?.system).not.toContain("couldn't be read in time");
  });

  it('Stop during a hung tree ends the turn as stopped without calling the model, and releases the chat', async () => {
    let treeCalls = 0;
    const h = await createHarness({
      treeTimeoutMs: 60_000,
      renderTree: () => (treeCalls++ === 0 ? never() : Promise.resolve('src/')),
      script: scriptFromTurns([reply('Hi'), TITLE_TURN, reply('Again'), TITLE_TURN]),
    });
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const run = h.run({ signal: controller.signal, emit: (e) => void events.push(e) });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.agent.isRunning(h.chatId)).toBe(true);
    controller.abort();
    await run;
    expect(h.provider.calls).toHaveLength(0);
    expect(find(events, 'assistant_end')[0]?.message).toMatchObject({ status: 'stopped', text: '' });
    expect(find(events, 'error')).toHaveLength(0);
    expect(events.at(-1)?.type).toBe('done');
    expect(h.agent.isRunning(h.chatId)).toBe(false);
    const next = await h.run();
    expect(find(next, 'error').filter((e) => e.error.code === 'conflict')).toHaveLength(0);
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

describe('usage (F1)', () => {
  // Every model call reports usage in these turns, so each assistant step counts once. `callTools` above has no usage.
  const reports = (): FakeStep => ({ type: 'usage', usage: { promptTokens: 120, completionTokens: 48 } });
  const toolStep = (): FakeStep[] => [
    ...textDeltas('Reading. ', 5),
    { type: 'tool_call', call: { id: 'c1', name: 'read_file', argsJson: '{"path":"README.md"}' } },
    reports(),
    { type: 'finish', reason: 'tool_calls' },
  ];
  const answerStep = (): FakeStep[] => [
    ...textDeltas('It is a readme.', 5),
    reports(),
    { type: 'finish', reason: 'stop' },
  ];

  it('the final chat_updated counts one request per assistant step of a tool turn', async () => {
    const h = await createHarness({ script: scriptFromTurns([toolStep(), answerStep(), TITLE_TURN]) });
    const events = await h.run();

    const steps = find(events, 'assistant_end');
    expect(steps).toHaveLength(2);
    const updates = find(events, 'chat_updated');
    expect(updates).toHaveLength(2); // the turn's, then the title's
    const expected = { contextTokens: 168, promptTokens: 240, completionTokens: 96, costUsd: null, requests: 2 };
    expect(updates.at(-1)?.chat.usage).toEqual(expected);
    expect(updates.at(-1)?.chat.usage.requests).toBe(steps.length);
    // The title request reports usage too, but it is not a chat request, so it is not counted.
    expect(h.provider.calls).toHaveLength(3);
    expect(updates[0]?.chat.usage).toEqual(expected);
  });

  it('a reply that fails after reporting usage still counts', async () => {
    const h = await createHarness({
      script: scriptFromTurns([
        [
          ...textDeltas('Half an ans', 6),
          reports(),
          { type: 'throw', error: new ProviderError('rate_limited', 'Slow down.', true, 429) },
        ],
      ]),
    });
    const events = await h.run();
    expect(find(events, 'assistant_end')[0]?.message).toMatchObject({ status: 'error' });
    expect(find(events, 'chat_updated').at(-1)?.chat.usage).toEqual({
      contextTokens: 168,
      promptTokens: 120,
      completionTokens: 48,
      costUsd: null,
      requests: 1,
    });
  });

  it('a stopped reply that reported usage counts in the trailing chat_updated', async () => {
    const h = await createHarness({
      script: scriptFromTurns([
        [
          ...textDeltas('Partial answer', 5),
          reports(),
          { type: 'delay', ms: 60_000 },
          { type: 'finish', reason: 'stop' },
        ],
      ]),
    });
    const controller = new AbortController();
    const run = h.run({ signal: controller.signal });
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    const events = await run;

    expect(find(events, 'assistant_end')[0]?.message).toMatchObject({
      status: 'stopped',
      usage: { promptTokens: 120, completionTokens: 48 },
    });
    expect(find(events, 'chat_updated').at(-1)?.chat.usage).toEqual({
      contextTokens: 168,
      promptTokens: 120,
      completionTokens: 48,
      costUsd: null,
      requests: 1,
    });
  });

  it('a retry keeps the discarded turn and adds the new reply in chat_updated.usage', async () => {
    const h = await createHarness({ script: scriptFromTurns([reply('Second try'), TITLE_TURN]) });
    const question: UserMessage = { id: 'u1', role: 'user', createdAt: 't', text: 'Question', attachments: [] };
    const failed: AssistantMessage = {
      id: 'a1',
      role: 'assistant',
      createdAt: 't',
      model: MODEL,
      text: 'oops',
      toolCalls: [],
      status: 'error',
      usage: { promptTokens: 100, completionTokens: 10 },
    };
    for (const m of [question, failed]) await h.chats.appendMessage(h.chatId, m);

    const events = await h.run({ newUserMessage: undefined });
    const expected = { contextTokens: 15, promptTokens: 110, completionTokens: 15, costUsd: null, requests: 2 };
    const updates = find(events, 'chat_updated');
    expect(updates).toHaveLength(2); // the turn's, then the title's
    expect(updates[0]?.chat.usage).toEqual(expected);
    expect(updates.at(-1)?.chat.usage).toEqual(expected);
    expect((await h.chats.get(h.chatId)).usage).toEqual(expected);
  });

  it('a reply that reports no usage is not counted, so the counter stays hidden', async () => {
    const h = await createHarness({
      script: scriptFromTurns([[...textDeltas('Hi!', 5), { type: 'finish', reason: 'stop' }], TITLE_TURN]),
    });
    const events = await h.run();
    expect(find(events, 'chat_updated').at(-1)?.chat.usage).toEqual({
      contextTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: null,
      requests: 0,
    });
  });
});

describe('effort (F3)', () => {
  const REASONING = [model(MODEL, { tools: true, images: true, reasoning: true })];
  const NO_REASONING = [model(MODEL, { tools: true, images: true })];

  it('sends the effort with the request for a reasoning model', async () => {
    const h = await createHarness({ script: scriptFromTurns([reply('Hi'), TITLE_TURN]), models: REASONING });
    await h.run({ effort: 'high' });
    expect(h.provider.calls[0]?.effort).toBe('high');
  });

  it('every request of a tool turn carries the effort', async () => {
    const h = await createHarness({
      script: scriptFromTurns([callTools([['c1', 'read_file', '{"path":"README.md"}']]), reply('Done.'), TITLE_TURN]),
      models: REASONING,
    });
    await h.run({ effort: 'low' });
    expect(h.provider.calls.slice(0, 2).map((c) => c.effort)).toEqual(['low', 'low']);
  });

  it('drops the effort for a model without reasoning, but still stores it on the chat', async () => {
    const h = await createHarness({ script: scriptFromTurns([reply('Hi'), TITLE_TURN]), models: NO_REASONING });
    const events = await h.run({ effort: 'high' });
    expect(h.provider.calls[0]).not.toHaveProperty('effort');
    expect((await h.chats.get(h.chatId)).effort).toBe('high');
    expect(find(events, 'chat_updated')[0]?.chat.effort).toBe('high');
  });

  it('null (Default) sends no effort, even to a reasoning model, and stores null', async () => {
    const h = await createHarness({ script: scriptFromTurns([reply('Hi'), TITLE_TURN]), models: REASONING });
    await h.run({ effort: 'medium' });
    await h.run({ effort: null, newUserMessage: { text: 'again', attachmentIds: [] } });
    expect(h.provider.calls[2]).not.toHaveProperty('effort');
    expect((await h.chats.get(h.chatId)).effort).toBeNull();
  });

  it('omitting effort keeps the stored one, for the request and for the chat', async () => {
    const h = await createHarness({
      script: scriptFromTurns([reply('Hi'), TITLE_TURN, reply('Again')]),
      models: REASONING,
    });
    await h.run({ effort: 'low' });
    await h.run({ newUserMessage: { text: 'more', attachmentIds: [] } });
    expect(h.provider.calls[2]?.effort).toBe('low');
    expect((await h.chats.get(h.chatId)).effort).toBe('low');
  });

  it('a retry uses the effort from the retry body and stores it', async () => {
    const h = await createHarness({
      script: scriptFromTurns([reply('Hi'), TITLE_TURN, reply('Retried')]),
      models: REASONING,
    });
    await h.run({ effort: 'low' });
    const events = await h.run({ newUserMessage: undefined, effort: 'max' });
    expect(h.provider.calls[2]?.effort).toBe('max');
    expect((await h.chats.get(h.chatId)).effort).toBe('max');
    expect(find(events, 'chat_updated').at(-1)?.chat.effort).toBe('max');
  });

  it('a retry without an effort keeps the stored one', async () => {
    const h = await createHarness({
      script: scriptFromTurns([reply('Hi'), TITLE_TURN, reply('Retried')]),
      models: REASONING,
    });
    await h.run({ effort: 'high' });
    await h.run({ newUserMessage: undefined });
    expect(h.provider.calls[2]?.effort).toBe('high');
  });

  it('chat.effort is persisted, and every chat_updated carries it', async () => {
    const h = await createHarness({ script: scriptFromTurns([reply('Hi'), TITLE_TURN]), models: REASONING });
    const events = await h.run({ effort: 'medium' });
    expect((await h.chats.get(h.chatId)).effort).toBe('medium');
    const updates = find(events, 'chat_updated');
    expect(updates).toHaveLength(2);
    for (const u of updates) expect(u.chat).toMatchObject({ id: h.chatId, effort: 'medium' });
  });

  it('title generation never sends an effort, even when the reply did', async () => {
    const h = await createHarness({ script: scriptFromTurns([reply('Hi'), TITLE_TURN]), models: REASONING });
    await h.run({ effort: 'high' });
    expect(h.provider.calls[0]?.effort).toBe('high');
    // calls[1] is the title request: no tools, maxTokens 30, and no effort.
    expect(h.provider.calls[1]?.maxTokens).toBe(30);
    expect(h.provider.calls[1]).not.toHaveProperty('effort');
    expect((await h.chats.get(h.chatId)).title).toBe('Friendly greeting');
  });
});
