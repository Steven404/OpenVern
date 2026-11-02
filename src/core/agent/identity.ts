// Model identity (v0.2 G6): tells the model what it is, who made it and where it runs. Pure.

import { APP_NAME } from '@shared/constants';
import type { ModelInfo } from '@shared/types';
import { authorFromSlug, splitModelName } from '../providers/models';

const DESCRIPTION_MAX_CHARS = 500;

/** Strips Markdown links (keeping the text), bare URLs and extra whitespace, then cuts at ~500 chars. */
export function trimDescription(description: string): string {
  const clean = description
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= DESCRIPTION_MAX_CHARS) return clean;
  const cut = clean.slice(0, DESCRIPTION_MAX_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${(space > DESCRIPTION_MAX_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function buildIdentity(model: ModelInfo, version: string): string {
  const slug = model.id.split('/')[0] ?? '';
  const { author: nameAuthor, displayName } = splitModelName(model.name);
  const author = model.author || nameAuthor || authorFromSlug(slug);
  const name = displayName || model.id;
  const router = slug === 'openrouter';
  const description = model.description ? trimDescription(model.description) : '';

  const lines = [
    `You are ${name} (${model.id}), made by ${author}, running inside ${APP_NAME} v${version}, a desktop app for working on local code projects. ${APP_NAME} is the app, not your name.`,
    `When asked who or what you are, name the model and its maker, mention ${APP_NAME}, and say in a sentence or two what the model is good at.`,
    `Do not claim to be ${APP_NAME} or any other model.`,
  ];
  if (router) {
    lines.push(
      'Your requests are routed by OpenRouter, so the underlying model may vary from message to message. Say so if asked, and do not claim a specific model.',
    );
  }
  lines.push(
    description
      ? `About this model, from its catalog description: ${description}`
      : "You have no details about this model's strengths; if asked, say so rather than guessing.",
  );
  return lines.join('\n');
}
