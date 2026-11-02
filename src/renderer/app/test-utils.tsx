// Test helpers for the S6 component tests: jsdom stubs Radix needs, a reset for the UI store, and `renderApp`.

import { MockApiClient, type MockApiClientOptions } from '@renderer/lib/mock-api-client';
import { readPersistedUi, useUiStore } from '@renderer/stores/ui';
import { QueryClient } from '@tanstack/react-query';
import { fireEvent, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { AppProviders, AppRoutes } from './App';

// jsdom lacks a few browser APIs Radix relies on.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};

/** Clears persisted UI state and resets the store (call from `beforeEach`). */
export function resetUi(): void {
  window.localStorage.clear();
  useUiStore.setState({
    ...readPersistedUi(),
    settingsOpen: false,
    newProjectOpen: false,
  });
}

/** Mirrors the router location into the DOM so tests can assert on navigation. */
function LocationProbe() {
  const { pathname, search } = useLocation();
  return <output data-testid="location">{pathname + search}</output>;
}

export function renderApp(opts: { route?: string; client?: MockApiClient; clientOptions?: MockApiClientOptions } = {}) {
  const client = opts.client ?? new MockApiClient({ delayMs: 0, ...opts.clientOptions });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (children: ReactNode) => (
    <AppProviders client={client} queryClient={queryClient}>
      <MemoryRouter initialEntries={[opts.route ?? '/new']}>
        {children}
        <LocationProbe />
      </MemoryRouter>
    </AppProviders>
  );
  const result = render(wrap(<AppRoutes />));
  return { ...result, client, queryClient };
}

export const location = () => document.querySelector('[data-testid="location"]')?.textContent ?? '';

/** Opens a Radix menu from the keyboard (jsdom has no pointer events). */
export function openMenu(trigger: HTMLElement): void {
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
}

/** The seed's newest chat plus its project (the design's "stefanos-ai-openvern" data). */
export async function seededClient() {
  const client = new MockApiClient({ delayMs: 0 });
  const projects = await client.listProjects();
  const chats = await client.listChats();
  const chat = chats[0];
  const project = projects.find((p) => p.id === chat?.projectId);
  if (!chat || !project) throw new Error('seed missing');
  return { client, projects, chats, chat, project };
}
