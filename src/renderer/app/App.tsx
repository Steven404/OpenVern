// App root: providers (TanStack Query + ApiClient) → hash router → shell.
//   #/new (default, and any unknown route) · #/chat/:id

import { NewChatScreen } from '@renderer/features/new-chat';
import type { ApiClient } from '@renderer/lib/api-client';
import { ApiClientProvider } from '@renderer/lib/api-context';
import { createApiClient } from '@renderer/lib/create-api-client';
import { paths } from '@renderer/lib/routes';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router';
import { AppShell } from './AppShell';
import { ChatScreen } from './ChatScreen';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
  });
}

/** QueryClient + ApiClient context. Tests pass their own `client` / `queryClient`. */
export function AppProviders({
  client,
  queryClient,
  children,
}: {
  client?: ApiClient;
  queryClient?: QueryClient;
  children: ReactNode;
}) {
  const [defaultClient] = useState(createApiClient);
  const [defaultQueryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient ?? defaultQueryClient}>
      <ApiClientProvider client={client ?? defaultClient}>{children}</ApiClientProvider>
    </QueryClientProvider>
  );
}

/** Routes only (needs a router above it): `HashRouter` in the app, `MemoryRouter` in tests. */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="new" element={<NewChatScreen />} />
        <Route path="chat/:id" element={<ChatScreen />} />
        <Route path="*" element={<Navigate to={paths.newChat()} replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <AppProviders>
      <HashRouter>
        <AppRoutes />
      </HashRouter>
    </AppProviders>
  );
}
