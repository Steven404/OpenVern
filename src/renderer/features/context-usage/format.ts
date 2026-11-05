// Number and date rules for the context counter and its popover (plan §5.1). Copied from the "Context usage"
// design board's preview script: exact under 1,000, thousands to one decimal with a trailing `.0` dropped, limits
// rounded to whole units. Pure, so the formatting is tested on its own.

export type ContextLevel = 'ok' | 'high' | 'full' | 'unknown';

export interface ContextView {
  level: ContextLevel;
  /** `used / limit` as a percentage, or null when the model reports no limit. */
  pct: number | null;
  /** `38%`, `<1%`, or `—` when the limit is unknown. */
  pctLabel: string;
  usedShort: string;
  /** The limit in short form; `—` when unknown. */
  limitShort: string;
  /** What follows the used figure in the popover: `/ 256k`, or `used` when the limit is unknown. */
  tail: string;
  /** Exact counts for the tooltip: `97,280 / 256,000 tokens`. */
  exact: string;
}

/** Under 1,000 exact, then thousands to one decimal: `97.3k`, `12k`. */
export function shortCount(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
}

/** Limits round to whole units: `256k`, `1M`, `1.05M`; `—` when unknown (null or 0). */
export function shortLimit(limit: number | null): string {
  if (!limit) return '—';
  if (limit >= 1e6) return `${(limit / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
  return `${Math.round(limit / 1000)}k`;
}

/** `12800` → `12,800` (en-US, as everywhere else in the UI). */
export function exact(n: number): string {
  return n.toLocaleString('en-US');
}

/** `0.64` → `$0.64`; tiny amounts read `<$0.01`; null (no request reported a cost) reads `—`. */
export function money(costUsd: number | null): string {
  if (costUsd === null) return '—';
  if (costUsd > 0 && costUsd < 0.01) return '<$0.01';
  return `$${costUsd.toFixed(2)}`;
}

const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });

/** `2026-11-05T14:14:00.000Z` → `Nov 5, 2026, 2:14 PM`. */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : dateFormat.format(date);
}

/** Everything the counter and the popover render for `used` of `limit`. Thresholds: 80 % high, 95 % full. */
export function contextView(used: number, limit: number | null): ContextView {
  const pct = limit ? (used / limit) * 100 : null;
  const level: ContextLevel = pct === null ? 'unknown' : pct >= 95 ? 'full' : pct >= 80 ? 'high' : 'ok';
  return {
    level,
    pct,
    pctLabel: pct === null ? '—' : pct > 0 && pct < 1 ? '<1%' : `${Math.floor(pct)}%`,
    usedShort: shortCount(used),
    limitShort: shortLimit(limit),
    tail: limit ? `/ ${shortLimit(limit)}` : 'used',
    exact: limit ? `${exact(used)} / ${exact(limit)} tokens` : `${exact(used)} tokens`,
  };
}
