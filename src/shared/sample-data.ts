// Sample models used by `FakeProvider` and `MockApiClient`. Real entries from openrouter.ai/models (2026-10-31),
// chosen to cover every capability combination the UI cares about.

import type { ModelInfo, Usage } from './types';

export const SAMPLE_MODELS: ModelInfo[] = [
  {
    id: 'anthropic/claude-sonnet-5.5',
    name: 'Anthropic: Claude Sonnet 5.5',
    contextLength: 1_000_000,
    supportsTools: true,
    supportsImages: true,
    promptPricePerMTok: 2,
    completionPricePerMTok: 10,
  },
  {
    id: 'anthropic/claude-opus-5.5',
    name: 'Anthropic: Claude Opus 5.5',
    contextLength: 1_000_000,
    supportsTools: true,
    supportsImages: true,
    promptPricePerMTok: 4,
    completionPricePerMTok: 20,
  },
  {
    id: 'anthropic/claude-haiku-5.5',
    name: 'Anthropic: Claude Haiku 5.5',
    contextLength: 1_000_000,
    supportsTools: true,
    supportsImages: true,
    promptPricePerMTok: 0.1,
    completionPricePerMTok: 0.5,
  },
  {
    id: 'openai/gpt-5.5',
    name: 'OpenAI: GPT-5.5',
    contextLength: 1_050_000,
    supportsTools: true,
    supportsImages: true,
    promptPricePerMTok: 5,
    completionPricePerMTok: 30,
  },
  {
    id: 'deepseek/deepseek-v3.2',
    name: 'DeepSeek: DeepSeek V3.2',
    contextLength: 163_840,
    supportsTools: true,
    supportsImages: false,
    promptPricePerMTok: 0.26,
    completionPricePerMTok: 0.38,
  },
  {
    id: 'google/gemma-3-4b-it',
    name: 'Google: Gemma 3 4B',
    contextLength: 131_072,
    supportsTools: false,
    supportsImages: true,
    promptPricePerMTok: 0.05,
    completionPricePerMTok: 0.1,
  },
  {
    // The router reports no context window, which is the Context popover's "limit unknown" state (F1).
    id: 'openrouter/auto',
    name: 'OpenRouter: Auto Router',
    contextLength: null,
    supportsTools: true,
    supportsImages: true,
    promptPricePerMTok: null,
    completionPricePerMTok: null,
  },
];

/**
 * Seeded per-request usage for the mock's sample chats (F1). One chat per counter level: rest, 80 % and over,
 * 95 % and over, and an unknown limit (the `openrouter/auto` model).
 */
export const SAMPLE_USAGE = {
  ok: { promptTokens: 372_000, completionTokens: 8_000, costUsd: 0.00074 },
  high: { promptTokens: 858_000, completionTokens: 2_000, costUsd: 0.0031 },
  full: { promptTokens: 971_000, completionTokens: 1_000, costUsd: 0.0042 },
  unknown: { promptTokens: 12_000, completionTokens: 400, costUsd: 0.00006 },
} satisfies Record<string, Usage>;
