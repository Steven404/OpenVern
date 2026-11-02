// FakeProvider: scripted `ProviderEvent` sequences with small delays. No key, no network, no cost.
// Used by `OPENVERN_FAKE_PROVIDER=1` and by tests.

import type { ErrorCode } from '@shared/errors';
import { SAMPLE_MODELS } from '@shared/sample-data';
import type { ModelInfo } from '@shared/types';
import { type Provider, ProviderError, type ProviderEvent, type ProviderRequest } from './types';

/** One step of a scripted response: an event, a pause, or a failure. */
export type FakeStep = ProviderEvent | { type: 'delay'; ms: number } | { type: 'throw'; error: ProviderError };

/** Produces the steps for the `callIndex`-th call to `stream()` (0-based, counted per provider instance). */
export type FakeScript = (req: ProviderRequest, callIndex: number) => FakeStep[];

export interface FakeProviderOptions {
  script?: FakeScript;
  models?: ModelInfo[];
  /** Pause before each event, in ms. Default 15; use 0 in tests. */
  delayMs?: number;
  /** Keys accepted by `validateKey`. Default: anything starting with `sk-or-`. */
  isValidKey?: (key: string) => boolean;
}

export interface FakeProvider extends Provider {
  /** Requests received by `stream()`, in order. */
  readonly calls: ProviderRequest[];
}

/** Splits text into small chunks, like a real stream. */
export function textDeltas(text: string, chunkSize = 12): ProviderEvent[] {
  const out: ProviderEvent[] = [];
  for (let i = 0; i < text.length; i += chunkSize)
    out.push({ type: 'text_delta', delta: text.slice(i, i + chunkSize) });
  return out;
}

/** A script that plays `turns[i]` on the i-th call, and the last turn for any later call. */
export function scriptFromTurns(turns: FakeStep[][]): FakeScript {
  return (_req, i) => turns[Math.min(i, turns.length - 1)] ?? [{ type: 'finish', reason: 'stop' }];
}

const FINAL_ANSWER = [
  'The README describes the project. The core of an agent loop looks like this:',
  '',
  '```ts',
  'while (true) {',
  '  const reply = await model.send(messages);',
  '  messages.push(reply);',
  '  if (!reply.toolCalls.length) break;',
  '  for (const call of reply.toolCalls) {',
  '    messages.push(await tools.run(call));',
  '  }',
  '}',
  '```',
  '',
  'Add a step limit early so a confused model cannot loop forever.',
].join('\n');

/**
 * Default script: if tools are offered and the last message is from the user, say something and call
 * `read_file` on `README.md`; otherwise answer with a fenced `ts` code block.
 */
export const defaultFakeScript: FakeScript = (req) => {
  const last = req.messages.at(-1);
  const usage: FakeStep = { type: 'usage', usage: { promptTokens: 120, completionTokens: 48 } };
  if (req.tools?.some((t) => t.name === 'read_file') && last?.role === 'user') {
    return [
      ...textDeltas("I'll start by reading the README."),
      {
        type: 'tool_call',
        call: { id: `call_${crypto.randomUUID()}`, name: 'read_file', argsJson: '{"path":"README.md"}' },
      },
      usage,
      { type: 'finish', reason: 'tool_calls' },
    ];
  }
  return [...textDeltas(FINAL_ANSWER), usage, { type: 'finish', reason: 'stop' }];
};

/** Pause between text deltas for `[fake:slow]`, so a stream can be stopped or navigated away from. */
const SLOW_DELTA_MS = 120;

/**
 * Test-only prompt markers understood by the fake provider (it never serves real users), so end-to-end tests can reach
 * states a scripted happy path cannot, in any host (dev server, Electron) without extra configuration:
 * - `[fake:slow]`: ~120 ms extra between text deltas;
 * - `[fake:error=<code>]`: the call fails with that error code (retryable only for `provider_error` / `rate_limited`
 *   / `network_error`);
 * - `[fake:flaky]`: the first call for that message fails with a retryable `provider_error`, later ones succeed;
 * - `[fake:read=<path>]`: the first tool call reads `<path>` instead of `README.md` (e.g. `../x` or `.env`, to
 *   exercise the sandbox through the whole stack).
 * Title requests (`maxTokens` set) ignore the markers.
 */
export function createDefaultFakeScript(): FakeScript {
  const flaked = new Set<string>();
  return (req, callIndex) => {
    const last = req.messages.at(-1);
    const text =
      last?.role === 'user' && req.maxTokens === undefined
        ? last.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
        : '';
    const steps = defaultFakeScript(req, callIndex);
    const error = /\[fake:error=([a-z_]+)\]/.exec(text)?.[1] as ErrorCode | undefined;
    if (error) {
      const retryable = error === 'provider_error' || error === 'rate_limited' || error === 'network_error';
      return [{ type: 'throw', error: new ProviderError(error, `Fake ${error} error.`, retryable) }];
    }
    if (text.includes('[fake:flaky]') && !flaked.has(text)) {
      flaked.add(text);
      return [{ type: 'throw', error: new ProviderError('provider_error', 'Fake provider hiccup.', true) }];
    }
    const readPath = /\[fake:read=([^\]]+)\]/.exec(text)?.[1];
    if (readPath) {
      return steps.map((step) =>
        step.type === 'tool_call' && step.call.name === 'read_file'
          ? { ...step, call: { ...step.call, argsJson: JSON.stringify({ path: readPath }) } }
          : step,
      );
    }
    if (text.includes('[fake:slow]')) {
      return steps.flatMap((step): FakeStep[] =>
        step.type === 'text_delta' ? [{ type: 'delay', ms: SLOW_DELTA_MS }, step] : [step],
      );
    }
    return steps;
  };
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

export function createFakeProvider(opts: FakeProviderOptions = {}): FakeProvider {
  const script = opts.script ?? createDefaultFakeScript();
  const delayMs = opts.delayMs ?? 15;
  const isValidKey = opts.isValidKey ?? ((k: string) => k.startsWith('sk-or-'));
  const models = opts.models ?? SAMPLE_MODELS;
  const calls: ProviderRequest[] = [];

  return {
    id: 'fake',
    calls,
    async listModels() {
      return structuredClone(models);
    },
    async validateKey(apiKey) {
      if (!isValidKey(apiKey)) throw new ProviderError('invalid_api_key', 'OpenRouter rejected this key.', false, 401);
    },
    async *stream(req, signal) {
      const callIndex = calls.push(structuredClone(req)) - 1;
      for (const step of script(req, callIndex)) {
        signal.throwIfAborted();
        if (step.type === 'delay') {
          await sleep(step.ms, signal);
          continue;
        }
        if (step.type === 'throw') throw step.error;
        if (delayMs > 0) await sleep(delayMs, signal);
        yield step;
      }
    },
  };
}
