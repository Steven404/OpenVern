// ApiClient React context (shared seam between S6 and S7). S6's app shell mounts `ApiClientProvider`;
// every feature reads the client with `useApiClient()` and never constructs one itself.

import { createContext, type ReactNode, useContext } from 'react';
import type { ApiClient } from './api-client';

const ApiClientContext = createContext<ApiClient | null>(null);

export function ApiClientProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  return <ApiClientContext.Provider value={client}>{children}</ApiClientContext.Provider>;
}

export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (!client) throw new Error('useApiClient() must be used inside <ApiClientProvider>');
  return client;
}
