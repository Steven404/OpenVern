import type { ApiClient } from './api-client';
import { HttpApiClient } from './http-api-client';
import { MockApiClient } from './mock-api-client';

/** `VITE_API=mock` → in-memory `MockApiClient`; otherwise the real `HttpApiClient`. */
export function createApiClient(): ApiClient {
  return import.meta.env.VITE_API === 'mock' ? new MockApiClient() : new HttpApiClient();
}
