// Placeholder until S6 builds the shell: proves fonts, tokens and the API pipeline work.

import { APP_NAME } from '@shared/constants';
import { useEffect, useMemo, useState } from 'react';
import { createApiClient } from '../lib/create-api-client';

type Health = { state: 'loading' } | { state: 'ok'; text: string } | { state: 'error'; text: string };

export function App() {
  const api = useMemo(createApiClient, []);
  const [health, setHealth] = useState<Health>({ state: 'loading' });

  useEffect(() => {
    api.health().then(
      (h) => setHealth({ state: 'ok', text: `API ${h.mode} · v${h.version}` }),
      (err: unknown) => setHealth({ state: 'error', text: err instanceof Error ? err.message : String(err) }),
    );
  }, [api]);

  return (
    <main className="flex h-full flex-col items-center justify-center gap-4">
      <h1 className="font-display text-[56px] font-bold tracking-[-0.02em] text-text">
        {APP_NAME}
        <span className="text-accent">.</span>
      </h1>
      <p
        data-testid="health"
        className={`font-mono text-xs ${health.state === 'error' ? 'text-danger' : 'text-text-faint'}`}
      >
        {health.state === 'loading' ? 'Checking API…' : health.text}
      </p>
    </main>
  );
}
