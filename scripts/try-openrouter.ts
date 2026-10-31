// Manual check against the real OpenRouter API (no automated test can do this).
//   OPENROUTER_API_KEY=sk-or-v1-... npx tsx --tsconfig tsconfig.node.json scripts/try-openrouter.ts "hello" [model]
// (`--tsconfig` is needed so tsx resolves the `@shared/*` path aliases used by src/.)
// Streams the reply to stdout; tool calls, usage and the finish reason go to stderr.

import { createOpenRouterProvider } from '../src/core/providers/openrouter';
import { ProviderError } from '../src/core/providers/types';
import { DEFAULT_MODEL } from '../src/shared/constants';

const prompt = process.argv[2] ?? 'Say hello in one short sentence.';
const model = process.argv[3] ?? DEFAULT_MODEL;
const apiKey = process.env.OPENROUTER_API_KEY ?? null;

if (!apiKey) {
  console.error('Set OPENROUTER_API_KEY first.');
  process.exit(1);
}

const provider = createOpenRouterProvider({ getApiKey: async () => apiKey });
const ac = new AbortController();
process.once('SIGINT', () => ac.abort());

try {
  await provider.validateKey(apiKey, ac.signal);
  console.error(`[key ok] model: ${model}`);
  for await (const e of provider.stream(
    {
      model,
      system: 'You are a concise assistant.',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    },
    ac.signal,
  )) {
    if (e.type === 'text_delta') process.stdout.write(e.delta);
    else console.error(`\n[${e.type}] ${JSON.stringify(e.type === 'tool_call' ? e.call : 'usage' in e ? e.usage : e)}`);
  }
  process.stdout.write('\n');
} catch (err) {
  if (err instanceof ProviderError) {
    console.error(
      `\nProviderError ${err.code} (status ${err.status ?? '-'}, retryable ${err.retryable}): ${err.message}`,
    );
  } else if (ac.signal.aborted) {
    console.error('\nAborted.');
  } else {
    console.error(err);
  }
  process.exit(1);
}
