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

const ACCESS_DENIED = {
  folder: {
    EPERM:
      'macOS blocked access to this folder. Allow access in System Settings › Privacy & Security › Files & Folders.',
    EACCES: "You don't have permission to read this folder. Check its permissions in Finder (File › Get Info).",
  },
  file: {
    EPERM: 'macOS blocked access to this file. Allow access in System Settings › Privacy & Security › Files & Folders.',
    EACCES: "You don't have permission to read this file. Check its permissions in Finder (File › Get Info).",
  },
} as const;

/**
 * On macOS, the `path_invalid` error for a filesystem access denial (AS-08): `EPERM` is a privacy control (TCC),
 * `EACCES` ordinary permissions. `undefined` for any other error and on every other platform, so callers keep
 * today's behaviour there.
 */
export function accessDeniedError(
  err: unknown,
  target: 'folder' | 'file',
  platform: NodeJS.Platform = process.platform,
): CoreError | undefined {
  if (platform !== 'darwin') return undefined;
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES' ? new CoreError('path_invalid', ACCESS_DENIED[target][code]) : undefined;
}
