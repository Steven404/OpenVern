// Model helpers shared by the composer, the picker and the conversation.

import { DEFAULT_MODEL } from '@shared/constants';
import type { ModelInfo } from '@shared/types';

/** `"Anthropic: Claude Sonnet 5.5"` → `"Claude Sonnet 5.5"`. Falls back to the id's last segment. */
export function modelName(model: ModelInfo | undefined, id: string): string {
  if (model) {
    const i = model.name.indexOf(': ');
    return i >= 0 ? model.name.slice(i + 2) : model.name;
  }
  return id.split('/').at(-1) ?? id;
}

/** `"Anthropic: Claude …"` → `"Anthropic"`; falls back to the id's vendor segment. */
export function modelProvider(model: ModelInfo): string {
  const i = model.name.indexOf(': ');
  if (i >= 0) return model.name.slice(0, i);
  return model.id.includes('/') ? (model.id.split('/')[0] ?? '') : '';
}

/**
 * Model for `#/new`: `lastModel` → `DEFAULT_MODEL` → first model with tools + images (plan §4.5).
 * `null` when the list is empty / not loaded and neither candidate exists.
 */
export function resolveDefaultModel(lastModel: string | null | undefined, models: ModelInfo[] | undefined): string {
  const candidates = [lastModel, DEFAULT_MODEL].filter((m): m is string => !!m);
  if (!models || models.length === 0) return candidates[0] ?? DEFAULT_MODEL;
  for (const id of candidates) if (models.some((m) => m.id === id)) return id;
  return (models.find((m) => m.supportsTools && m.supportsImages) ?? models[0])?.id ?? DEFAULT_MODEL;
}
