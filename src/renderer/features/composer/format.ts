// Small formatters shared by the conversation and composer.

/** `0.2s`, `1.4s`, `12s`; `1m 5s` from a minute up. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 9.95) return `${seconds.toFixed(1)}s`;
  if (seconds < 59.5) return `${Math.round(seconds)}s`;
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

/** `412 B`, `1.5 KB`, `3.2 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${stripZero(bytes / 1024)} KB`;
  return `${stripZero(bytes / (1024 * 1024))} MB`;
}

const stripZero = (n: number) => n.toFixed(1).replace(/\.0$/, '');

/** Context window as shown in the model picker: `200K`, `131K`, `1M`, `1.05M`. */
export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(2))}M`;
  return `${Math.round(tokens / 1000)}K`;
}
