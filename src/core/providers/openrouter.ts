// OpenRouter provider (plan S2): a thin adapter over raw `fetch`, no SDK.
// Wire-format notes (verified against the OpenRouter docs, 2026-10):
//  - Streams are Chat Completions SSE. `: OPENROUTER PROCESSING` comment lines are keepalives (dropped by `readSSE`).
//  - A final chunk carries `usage` and repeats `finish_reason` (it is NOT an empty-`choices` chunk), then `[DONE]`.
//  - Mid-stream failures arrive with HTTP 200 as a chunk with a top-level `error` and `finish_reason: "error"`.
//  - Pre-stream failures are JSON `{ error: { code: <http status>, message, metadata? } }` with that HTTP status.
//  - Reasoning arrives in `delta.reasoning_details` and must be passed back unmodified as `reasoning_details`.

import { ERROR_DEFAULTS, type ErrorCode } from '@shared/errors';
import { readSSE } from '@shared/sse';
import type { ModelInfo, ToolCall, Usage } from '@shared/types';
import {
  type ContentPart,
  type GetApiKey,
  type Provider,
  ProviderError,
  type ProviderEvent,
  type ProviderMessage,
  type ProviderRequest,
  type ToolSpec,
} from './types';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface OpenRouterOptions {
  getApiKey: GetApiKey;
  /** Injected for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

// ── error mapping (S2.5) ───────────────────────────────────────────────────────────────────────

interface ErrorHints {
  /** HTTP status (or the numeric `error.code` of a mid-stream chunk). */
  status?: number;
  message?: string;
  /** `error.metadata.error_type`, e.g. `rate_limit_exceeded`. */
  errorType?: string;
  /** `error.metadata.raw`: the upstream provider's own text, useful for classification. */
  raw?: string;
}

const CONTEXT_RE =
  /context[ _-]?(length|window)|maximum context|too many tokens|prompt is too long|exceeds? the (model'?s )?(maximum|max)/i;
const NO_TOOLS_RE = /no endpoints found.*(tool|function)/i;
const NO_IMAGES_RE = /no endpoints found.*(image|vision|multimodal)/i;
const MODEL_RE =
  /no endpoints found|not a valid model|model.{0,40}(not found|does not exist|not available|unavailable)|no allowed providers/i;

function providerError(code: ErrorCode, status: number | undefined, detail?: string, retryable?: boolean) {
  const d = ERROR_DEFAULTS[code];
  const clean = detail?.replace(/\s+/g, ' ').trim().slice(0, 300);
  let message = d.message;
  if (clean && code === 'provider_error') message = `The model provider returned an error: ${clean}`;
  if (clean && code === 'invalid_request') message = clean;
  return new ProviderError(code, message, retryable ?? d.retryable, status);
}

/** Maps an OpenRouter error (HTTP or mid-stream) to a `ProviderError`. */
export function mapOpenRouterError(h: ErrorHints): ProviderError {
  const { status, errorType } = h;
  const text = `${h.message ?? ''} ${h.raw ?? ''}`;
  if (status === 401 || errorType === 'authentication') return providerError('invalid_api_key', status);
  if (status === 402 || errorType === 'payment_required') return providerError('insufficient_credits', status);
  if (status === 429 || errorType === 'rate_limit_exceeded') return providerError('rate_limited', status);
  if (NO_TOOLS_RE.test(text)) return providerError('model_no_tools', status);
  if (NO_IMAGES_RE.test(text)) return providerError('model_no_image_input', status);
  if (CONTEXT_RE.test(text)) return providerError('context_length_exceeded', status);
  if (status === 404 || MODEL_RE.test(text)) return providerError('model_unavailable', status);
  if (status === 403) return providerError('provider_error', status, h.message, false);
  if (status === 400) return providerError('invalid_request', status, h.message);
  return providerError('provider_error', status, h.message, true);
}

function hintsFromErrorObject(err: unknown, httpStatus?: number): ErrorHints {
  const e = (typeof err === 'object' && err !== null ? err : {}) as Record<string, unknown>;
  const meta = (typeof e.metadata === 'object' && e.metadata !== null ? e.metadata : {}) as Record<string, unknown>;
  const rawMeta = meta.raw;
  return {
    status: httpStatus ?? (typeof e.code === 'number' ? e.code : undefined),
    message: typeof e.message === 'string' ? e.message : undefined,
    errorType: typeof meta.error_type === 'string' ? meta.error_type : undefined,
    raw: typeof rawMeta === 'string' ? rawMeta : rawMeta === undefined ? undefined : JSON.stringify(rawMeta),
  };
}

async function errorFromResponse(res: Response): Promise<ProviderError> {
  let body: unknown;
  const text = await res.text().catch(() => '');
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const errObj =
    (typeof body === 'object' && body !== null && 'error' in body ? (body as { error: unknown }).error : undefined) ??
    {};
  const hints = hintsFromErrorObject(errObj, res.status);
  if (!hints.message && text && body === undefined) hints.message = text.slice(0, 300);
  return mapOpenRouterError(hints);
}

// ── request mapping (S2.2) ─────────────────────────────────────────────────────────────────────

function mapContent(parts: ContentPart[]) {
  if (parts.length === 1 && parts[0]?.type === 'text') return parts[0].text;
  return parts.map((p) =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.base64}` } },
  );
}

export function mapMessages(system: string, messages: ProviderMessage[]): unknown[] {
  const out: unknown[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: mapContent(m.content) });
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    } else {
      const msg: Record<string, unknown> = {
        role: 'assistant',
        content: m.text === '' && m.toolCalls.length > 0 ? null : m.text,
      };
      if (m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.argsJson },
        }));
      }
      if (Array.isArray(m.providerMeta) && m.providerMeta.length > 0) msg.reasoning_details = m.providerMeta;
      out.push(msg);
    }
  }
  return out;
}

function mapTools(tools: ToolSpec[]) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

// ── stream parsing (S2.3, S2.4, S2.7) ──────────────────────────────────────────────────────────

interface WireToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}
interface WireChunk {
  error?: unknown;
  choices?: {
    delta?: { content?: string | null; tool_calls?: WireToolCallDelta[]; reasoning_details?: unknown[] };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } | null;
}

interface PendingCall {
  id: string;
  name: string;
  args: string;
}

type Detail = Record<string, unknown>;

/**
 * Streamed `reasoning_details` arrive as fragments. `reasoning.text` / `reasoning.summary` fragments with the same
 * `index` are merged (strings concatenated, last non-null signature wins) so the stored sequence matches what the
 * non-streaming API would return. Other detail types (e.g. `reasoning.encrypted`) are kept as received.
 */
function addDetails(into: Detail[], incoming: unknown[]): void {
  for (const raw of incoming) {
    if (typeof raw !== 'object' || raw === null) continue;
    const d = raw as Detail;
    const last = into.at(-1);
    const field = d.type === 'reasoning.text' ? 'text' : d.type === 'reasoning.summary' ? 'summary' : null;
    if (
      field &&
      last &&
      last.type === d.type &&
      last.index === d.index &&
      (last.id === d.id || d.id == null || last.id == null)
    ) {
      const prev = typeof last[field] === 'string' ? last[field] : '';
      last[field] = `${prev}${typeof d[field] === 'string' ? d[field] : ''}`;
      for (const k of ['signature', 'id', 'format'] as const) if (d[k] != null) last[k] = d[k];
      continue;
    }
    into.push({ ...d });
  }
}

function mapFinish(reason: string): 'stop' | 'tool_calls' | 'length' | 'other' {
  if (reason === 'stop') return 'stop';
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_calls';
  if (reason === 'length') return 'length';
  return 'other';
}

async function* parseStream(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
  const pending = new Map<number, PendingCall>();
  const details: Detail[] = [];
  let usage: Usage | undefined;
  let finishReason: string | undefined;
  let flushed = false;
  let sawDone = false;
  let emittedToolCalls = false;

  const flush = function* (): Generator<ProviderEvent> {
    if (flushed) return;
    flushed = true;
    if (details.length > 0) yield { type: 'meta', providerMeta: details };
    for (const [, c] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      const call: ToolCall = { id: c.id, name: c.name, argsJson: c.args.trim() === '' ? '{}' : c.args };
      emittedToolCalls = true;
      yield { type: 'tool_call', call };
    }
  };

  try {
    for await (const data of readSSE(body)) {
      const payload = data.trim();
      if (payload === '') continue;
      if (payload === '[DONE]') {
        sawDone = true;
        break;
      }
      let chunk: WireChunk;
      try {
        chunk = JSON.parse(payload) as WireChunk;
      } catch {
        throw new ProviderError('provider_error', 'The model provider sent a malformed response. Try again.', true);
      }
      if (chunk.error) throw mapOpenRouterError(hintsFromErrorObject(chunk.error));

      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (!finishReason && delta) {
        if (typeof delta.content === 'string' && delta.content !== '') {
          yield { type: 'text_delta', delta: delta.content };
        }
        if (delta.reasoning_details?.length) addDetails(details, delta.reasoning_details);
        for (const tc of delta.tool_calls ?? []) {
          let idx = tc.index;
          if (idx === undefined) {
            // Non-conforming provider: no index. A new id starts a new call, otherwise continue the last one.
            const byId = tc.id ? [...pending.entries()].find(([, p]) => p.id === tc.id)?.[0] : undefined;
            idx = byId ?? (tc.id ? pending.size : Math.max(pending.size - 1, 0));
          }
          let p = pending.get(idx);
          if (!p) {
            p = { id: '', name: '', args: '' };
            pending.set(idx, p);
          }
          if (tc.id && !p.id) p.id = tc.id;
          if (tc.function?.name && !p.name) p.name = tc.function.name;
          if (tc.function?.arguments) p.args += tc.function.arguments;
        }
      }
      // The usage chunk repeats `finish_reason`; only the first one counts.
      if (choice?.finish_reason && !finishReason) {
        if (choice.finish_reason === 'error') {
          throw new ProviderError('provider_error', ERROR_DEFAULTS.provider_error.message, true);
        }
        finishReason = choice.finish_reason;
        yield* flush();
      }
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          completionTokens: chunk.usage.completion_tokens ?? 0,
          ...(typeof chunk.usage.cost === 'number' ? { costUsd: chunk.usage.cost } : {}),
        };
      }
    }
  } catch (err) {
    if (err instanceof ProviderError || signal.aborted) throw err;
    throw new ProviderError('network_error', ERROR_DEFAULTS.network_error.message, true);
  }

  if (!finishReason && !sawDone) {
    throw new ProviderError('network_error', 'The connection to OpenRouter ended before the reply was complete.', true);
  }
  yield* flush();
  if (usage) yield { type: 'usage', usage };
  yield { type: 'finish', reason: emittedToolCalls ? 'tool_calls' : mapFinish(finishReason ?? 'other') };
}

// ── models (S2.9) ──────────────────────────────────────────────────────────────────────────────

interface WireModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  architecture?: { input_modalities?: unknown; output_modalities?: unknown };
  supported_parameters?: unknown;
  top_provider?: { context_length?: unknown };
}

/** Per-token USD string → USD per million tokens. Missing, non-numeric or negative (router pseudo-prices) → null. */
function perMTok(v: unknown): number | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Number((n * 1e6).toPrecision(12));
}

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export function mapModels(data: unknown): ModelInfo[] {
  if (!Array.isArray(data)) {
    throw new ProviderError('provider_error', 'OpenRouter returned an unexpected model list.', true);
  }
  const out: ModelInfo[] = [];
  for (const m of data as WireModel[]) {
    if (typeof m?.id !== 'string' || m.id === '') continue;
    const outputs =
      m.architecture?.output_modalities === undefined ? ['text'] : strArray(m.architecture.output_modalities);
    if (!outputs.includes('text')) continue;
    const ctx = m.context_length ?? m.top_provider?.context_length;
    out.push({
      id: m.id,
      name: typeof m.name === 'string' && m.name !== '' ? m.name : m.id,
      contextLength: typeof ctx === 'number' && Number.isFinite(ctx) ? ctx : null,
      supportsTools: strArray(m.supported_parameters).includes('tools'),
      supportsImages: strArray(m.architecture?.input_modalities).includes('image'),
      promptPricePerMTok: perMTok(m.pricing?.prompt),
      completionPricePerMTok: perMTok(m.pricing?.completion),
    });
  }
  return out;
}

// ── provider ───────────────────────────────────────────────────────────────────────────────────

export function createOpenRouterProvider(opts: OpenRouterOptions): Provider {
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));

  const headers = (key: string, json = false): Record<string, string> => ({
    Authorization: `Bearer ${key}`,
    // `HTTP-Referer` is deliberately omitted until the project has a public URL (plan S2.1).
    'X-OpenRouter-Title': 'harness',
    'X-Title': 'harness', // legacy name, still supported
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  });

  async function request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    try {
      return await doFetch(url, { ...init, signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new ProviderError('network_error', ERROR_DEFAULTS.network_error.message, true);
    }
  }

  async function requireKey(): Promise<string> {
    const key = await opts.getApiKey();
    if (!key) throw new ProviderError('no_api_key', ERROR_DEFAULTS.no_api_key.message, false);
    return key;
  }

  return {
    id: 'openrouter',

    async listModels(signal) {
      const key = await requireKey();
      const res = await request(`${OPENROUTER_BASE_URL}/models`, { method: 'GET', headers: headers(key) }, signal);
      if (!res.ok) throw await errorFromResponse(res);
      let body: unknown;
      try {
        body = await res.json();
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new ProviderError('provider_error', 'OpenRouter returned an unexpected model list.', true);
      }
      return mapModels((body as { data?: unknown } | null)?.data);
    },

    async validateKey(apiKey, signal) {
      const res = await request(`${OPENROUTER_BASE_URL}/key`, { method: 'GET', headers: headers(apiKey) }, signal);
      if (res.ok) {
        await res.body?.cancel().catch(() => {});
        return;
      }
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel().catch(() => {});
        throw providerError('invalid_api_key', res.status);
      }
      throw await errorFromResponse(res);
    },

    async *stream(req: ProviderRequest, signal: AbortSignal) {
      const key = await requireKey();
      const body: Record<string, unknown> = {
        model: req.model,
        messages: mapMessages(req.system, req.messages),
        stream: true,
      };
      if (req.tools && req.tools.length > 0) body.tools = mapTools(req.tools);
      if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;

      const res = await request(
        `${OPENROUTER_BASE_URL}/chat/completions`,
        { method: 'POST', headers: { ...headers(key, true), Accept: 'text/event-stream' }, body: JSON.stringify(body) },
        signal,
      );
      if (!res.ok) throw await errorFromResponse(res);
      if (!res.body) throw new ProviderError('provider_error', 'OpenRouter returned an empty response.', true);
      yield* parseStream(res.body, signal);
    },
  };
}
