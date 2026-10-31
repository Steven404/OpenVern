// Small helpers shared by the tools: argument parsing, result builders, schema generation.

import { z } from 'zod';
import type { ToolResult } from './types';

export function fail(message: string, summary: string): ToolResult {
  return { ok: false, output: message, summary };
}

export function succeed(output: string, summary: string): ToolResult {
  return { ok: true, output, summary };
}

export function abortedResult(summary: string): ToolResult {
  return fail('Cancelled before finishing.', summary);
}

/** Validates raw model-supplied arguments; the error message tells the model exactly what to fix. */
export function parseArgs<S extends z.ZodType>(
  schema: S,
  rawArgs: unknown,
): { ok: true; data: z.output<S> } | { ok: false; message: string } {
  const parsed = schema.safeParse(rawArgs ?? {});
  if (parsed.success) return { ok: true, data: parsed.data };
  const problems = parsed.error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : 'arguments';
    return `${where}: ${issue.message}`;
  });
  return { ok: false, message: `Invalid arguments. ${problems.join('; ')}` };
}

/** JSON Schema (as sent to the provider) for a zod args schema, without the `$schema` marker. */
export function toParameters(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  return rest;
}

export function displayPath(rel: string): string {
  return rel === '' ? '.' : rel;
}
