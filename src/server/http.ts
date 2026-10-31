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

/** Parses and validates a JSON body. Throws `CoreError('invalid_request')` (mapped to 400 by the error handler). */
export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    const text = await c.req.text();
    raw = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    throw new CoreError('invalid_request', 'The request body is not valid JSON.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new CoreError('invalid_request', describeZodError(parsed.error));
  return parsed.data;
}
