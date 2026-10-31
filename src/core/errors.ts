// Coded errors thrown by core services (storage, agent, tools wiring). The server (S5) maps them to
// `ApiErrorBody` with `ERROR_STATUS[code]`. Providers throw `ProviderError` (providers/types.ts) instead.

import { type ApiErrorInfo, type ErrorCode, errorInfo } from '@shared/errors';
import { ProviderError } from './providers/types';

export class CoreError extends Error {
  constructor(
    public code: ErrorCode,
    message?: string,
  ) {
    super(message ?? errorInfo(code).message);
    this.name = 'CoreError';
  }

  get info(): ApiErrorInfo {
    return errorInfo(this.code, this.message);
  }
}

/** Normalises anything thrown into user-facing `ApiErrorInfo`. Unknown errors become `internal`. */
export function toErrorInfo(err: unknown): ApiErrorInfo {
  if (err instanceof CoreError) return err.info;
  if (err instanceof ProviderError) return { code: err.code, message: err.message, retryable: err.retryable };
  return errorInfo('internal');
}
