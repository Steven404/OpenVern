// Test-only helpers: a real core (storage, tools, agent) in a temp dir behind `createApp`, with a scripted FakeProvider.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CLIENT_HEADER, CLIENT_HEADER_VALUE } from '@shared/constants';
import type { AgentEvent } from '@shared/events';
import { readSSE } from '@shared/sse';
import type { Hono } from 'hono';
import { createCore } from '../core';
import { createFakeProvider, type FakeProvider, type FakeScript } from '../core/providers/fake';
import type { Provider } from '../core/providers/types';
import { createFileSecretStore } from '../core/storage';
import type { Core } from '../core/types';
import { createApp } from './app';

export interface Harness {
  app: Hono;
  core: Core;
  provider: FakeProvider;
  dataDir: string;
  /** A temp project folder containing `README.md`. */
  projectDir: string;
  /** `app.request` with `X-Harness-Client: 1`; objects are sent as JSON. */
  call(
    path: string,
    init?: Omit<RequestInit, 'body'> & { json?: unknown; body?: RequestInit['body'] },
  ): Promise<Response>;
  cleanup(): Promise<void>;
}

export interface HarnessOptions {
  script?: FakeScript;
  /** Wrap the fake provider (e.g. to make `listModels` fail). */
  wrapProvider?: (fake: FakeProvider) => Provider;
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-server-'));
  const dataDir = path.join(root, 'data');
  const projectDir = path.join(root, 'project');
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, 'README.md'), '# Demo project\n\nHello from the README.\n');

  const provider = createFakeProvider({ delayMs: 0, script: opts.script });
  const core = await createCore({
    dataDir,
    secretStore: createFileSecretStore(dataDir),
    provider: opts.wrapProvider ? opts.wrapProvider(provider) : provider,
    mode: 'dev',
  });
  const app = createApp(core, { mode: 'dev', version: '9.9.9' });

  return {
    app,
    core,
    provider,
    dataDir,
    projectDir,
    async call(p, init = {}) {
      const { json, headers, ...rest } = init;
      const h = new Headers(headers);
      if (!h.has(CLIENT_HEADER)) h.set(CLIENT_HEADER, CLIENT_HEADER_VALUE);
      let body = init.body;
      if (json !== undefined) {
        h.set('Content-Type', 'application/json');
        body = JSON.stringify(json);
      }
      return app.request(p, { ...rest, headers: h, body });
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Reads a whole SSE response into events (comment frames are skipped by `readSSE`). */
export async function collectEvents(res: Response): Promise<AgentEvent[]> {
  if (!res.body) throw new Error('response has no body');
  const out: AgentEvent[] = [];
  for await (const data of readSSE(res.body)) out.push(JSON.parse(data) as AgentEvent);
  return out;
}

/** Event types with consecutive repeats collapsed (`text_delta` × n → one entry). */
export function shape(events: AgentEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) if (out.at(-1) !== e.type) out.push(e.type);
  return out;
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Smallest bytes that sniff as PNG (magic number is all the sniffer checks). */
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

export function uploadForm(bytes: Uint8Array | string, name: string, type = 'application/octet-stream'): FormData {
  const form = new FormData();
  const part = typeof bytes === 'string' ? bytes : new Uint8Array(bytes);
  form.append('file', new File([part], name, { type }));
  return form;
}
