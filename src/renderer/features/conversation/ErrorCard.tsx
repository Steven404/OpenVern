import type { ApiErrorInfo, ErrorCode } from '@shared/errors';
import { AlertCircle } from 'lucide-react';
import { Button } from '../../components/ui';
import { useUiStore } from '../../stores/ui';

/** Errors the user fixes in Settings (key / credits) rather than by retrying. */
export const SETTINGS_ERRORS: readonly ErrorCode[] = ['no_api_key', 'invalid_api_key', 'insufficient_credits'];

export interface ErrorCardProps {
  error: ApiErrorInfo;
  /** Offered when the error is retryable (or after a stop). Omit on past turns. */
  onRetry?: () => void;
  /** Show "Retry" even if the error is not marked retryable (a message that never reached the server). */
  forceRetry?: boolean;
}

/** Danger-tinted card for run errors and `status: 'error'` messages (S7.8). */
export function ErrorCard({ error, onRetry, forceRetry = false }: ErrorCardProps) {
  const openSettings = useUiStore((s) => s.openSettings);
  const needsSettings = SETTINGS_ERRORS.includes(error.code);
  return (
    <div
      role="alert"
      data-testid="error-card"
      className="flex items-start gap-3 rounded-[12px] border border-danger/50 bg-danger/8 px-4 py-3 text-[14px] leading-[1.5] text-text"
    >
      <AlertCircle aria-hidden="true" size={18} className="mt-0.5 shrink-0 text-danger" />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <p className="m-0">{error.message}</p>
        {needsSettings || (onRetry && (error.retryable || forceRetry)) ? (
          <div className="flex gap-2">
            {needsSettings && (
              <Button size="sm" onClick={openSettings}>
                Open settings
              </Button>
            )}
            {onRetry && (forceRetry || (!needsSettings && error.retryable)) && (
              <Button size="sm" onClick={onRetry}>
                Retry
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
