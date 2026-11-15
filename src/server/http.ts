// Shared HTTP helpers: error responses and request-body validation.

import { ERROR_STATUS, type ErrorCode, errorInfo } from '@shared/errors';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import { CoreError } from '../core/errors';

/** Sends an `ApiErrorBody`. `status` defaults to `ERROR_STATUS[code]`. */
export function errorResponse(c: Context, code: ErrorCode, message?: string, status?: number): Response {
  return c.json({ error: errorInfo(code, message) }, (status ?? ERROR_STATUS[code]) as ContentfulStatusCode);
}

/** `path: message` of the first zod issue, so clients get something actionable. */
function describeZodError(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return 'The request was not valid.';
  const where = issue.path.join('.');
  return where ? `Invalid "${where}": ${issue.message}` : issue.message;
}

/**
 * The path of the first property in `raw` that the schema dropped from `parsed` (zod strips unknown keys), or
 * undefined when there is none. Walks the raw value's keys, so it is bounded by the body size.
 */
function unknownProperty(raw: unknown, parsed: unknown, path: string[] = []): string | undefined {
  if (Array.isArray(raw) && Array.isArray(parsed)) {
    for (let i = 0; i < parsed.length; i++) {
      const found = unknownProperty(raw[i], parsed[i], [...path, String(i)]);
      if (found) return found;
    }
    return undefined;
  }
  if (raw === null || parsed === null || typeof raw !== 'object' || typeof parsed !== 'object') return undefined;
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(parsed, key)) return [...path, key].join('.');
    const found = unknownProperty((raw as Record<string, unknown>)[key], (parsed as Record<string, unknown>)[key], [
      ...path,
      key,
    ]);
    if (found) return found;
  }
  return undefined;
}

export interface ReadJsonOptions {
  /** Reject a body with properties the schema does not know, at any depth, instead of dropping them. */
  strict?: boolean;
}

/** Parses and validates a JSON body. Throws `CoreError('invalid_request')` (mapped to 400 by the error handler). */
export async function readJson<S extends z.ZodType>(
  c: Context,
  schema: S,
  opts: ReadJsonOptions = {},
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    const text = await c.req.text();
    raw = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    throw new CoreError('invalid_request', 'The request body is not valid JSON.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new CoreError('invalid_request', describeZodError(parsed.error));
  if (opts.strict) {
    const unknown = unknownProperty(raw, parsed.data);
    if (unknown) throw new CoreError('invalid_request', `Unknown property "${unknown}".`);
  }
  return parsed.data;
}
