// Shared helpers for the S7 component tests (not part of the app bundle).

import type { Chat } from '@shared/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { ApiClientProvider } from '../../lib/api-context';
import { MockApiClient, type MockApiClientOptions } from '../../lib/mock-api-client';
import { queryKeys } from '../../lib/query-keys';
import { useRunsStore } from '../../stores/runs';
import { useUiStore } from '../../stores/ui';

/** jsdom lacks a few browser APIs that Radix and cmdk rely on. Call once in `beforeAll`. */
export function installDomStubs() {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  URL.createObjectURL ??= () => 'blob:mock';
  URL.revokeObjectURL ??= () => {};
}

export function resetStores() {
  useRunsStore.setState({ runs: {}, chatModels: {}, chatEfforts: {} });
  useUiStore.setState({ settingsOpen: false, newProjectOpen: false });
}

export interface RenderOptions {
  api?: MockApiClient;
  mock?: MockApiClientOptions;
  route?: string;
  /** Chats put straight into the query cache (never refetched: `staleTime` is infinite). */
  chats?: Chat[];
}

export function renderWithProviders(ui: ReactElement, opts: RenderOptions = {}) {
  const api = opts.api ?? new MockApiClient({ delayMs: 0, ...opts.mock });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
  for (const chat of opts.chats ?? []) queryClient.setQueryData(queryKeys.chat(chat.id), chat);
  const result = render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={api}>
        <MemoryRouter initialEntries={[opts.route ?? '/']}>{ui}</MemoryRouter>
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  return { api, queryClient, ...result };
}
