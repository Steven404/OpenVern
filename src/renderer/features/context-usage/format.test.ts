import { describe, expect, it } from 'vitest';
import { contextView, exact, formatDate, money, shortCount, shortLimit } from './format';

describe('shortCount', () => {
  it('shows counts under 1,000 exactly', () => {
    expect(shortCount(0)).toBe('0');
    expect(shortCount(999)).toBe('999');
  });

  it('shows thousands to one decimal', () => {
    expect(shortCount(97_280)).toBe('97.3k');
    expect(shortCount(12_340)).toBe('12.3k');
  });

  it('drops a trailing .0', () => {
    expect(shortCount(12_000)).toBe('12k');
    expect(shortCount(1_000)).toBe('1k');
  });
});

describe('shortLimit', () => {
  it('rounds limits to whole units', () => {
    expect(shortLimit(256_000)).toBe('256k');
    expect(shortLimit(131_072)).toBe('131k');
    expect(shortLimit(163_840)).toBe('164k');
  });

  it('shows millions with up to two decimals, dropping trailing zeros', () => {
    expect(shortLimit(1_000_000)).toBe('1M');
    expect(shortLimit(1_050_000)).toBe('1.05M');
    expect(shortLimit(1_200_000)).toBe('1.2M');
  });

  it('reads a missing or zero limit as —', () => {
    expect(shortLimit(null)).toBe('—');
    expect(shortLimit(0)).toBe('—');
  });
});

describe('exact', () => {
  it('uses en-US thousands separators', () => {
    expect(exact(12_800)).toBe('12,800');
    expect(exact(256_000)).toBe('256,000');
  });
});

describe('money', () => {
  it('reads tiny positive amounts as <$0.01', () => {
    expect(money(0.004)).toBe('<$0.01');
    expect(money(0.0031)).toBe('<$0.01');
  });

  it('keeps amounts from one cent up at two decimals', () => {
    expect(money(0.01)).toBe('$0.01');
    expect(money(0.64)).toBe('$0.64');
    expect(money(1.5)).toBe('$1.50');
  });

  it('reads a reported zero as $0.00', () => {
    expect(money(0)).toBe('$0.00');
  });

  it('reads an unknown cost (no request reported one) as —', () => {
    expect(money(null)).toBe('—');
  });
});

describe('formatDate', () => {
  it('formats as "Nov 5, 2026, 2:14 PM"', () => {
    // Built from local time, so the expectation does not depend on the runner's time zone.
    const iso = new Date(2026, 10, 5, 14, 14).toISOString();
    // Node's ICU puts a narrow no-break space (U+202F) before AM/PM; the copy uses a plain space.
    expect(formatDate(iso).replace(/ /g, ' ')).toBe('Nov 5, 2026, 2:14 PM');
  });

  it('reads an unparseable date as —', () => {
    expect(formatDate('not a date')).toBe('—');
  });
});

describe('contextView', () => {
  it('reads 97,280 of 256,000 as 38%, "97.3k" used, "/ 256k", with the exact tooltip', () => {
    const view = contextView(97_280, 256_000);
    expect(view).toMatchObject({
      level: 'ok',
      pctLabel: '38%',
      usedShort: '97.3k',
      limitShort: '256k',
      tail: '/ 256k',
      exact: '97,280 / 256,000 tokens',
    });
    expect(view.pct).toBeCloseTo(38, 10);
  });

  it('thresholds: 79.9% is ok, 80% is high, 95% is full', () => {
    expect(contextView(204_544, 256_000).level).toBe('ok'); // 79.9%
    expect(contextView(204_800, 256_000).level).toBe('high'); // 80%
    expect(contextView(243_200, 256_000).level).toBe('full'); // 95%
  });

  it('94.9% is still high', () => {
    expect(contextView(949, 1_000).level).toBe('high'); // 94.9%
  });

  it('reads above 0 and under 1% as <1%', () => {
    expect(contextView(500, 256_000).pctLabel).toBe('<1%');
  });

  it('reads exactly 0 as 0%', () => {
    expect(contextView(0, 256_000).pctLabel).toBe('0%');
  });

  it('a null limit is unknown: — for the percentage and the limit, "used" as the tail, no ratio', () => {
    expect(contextView(97_280, null)).toEqual({
      level: 'unknown',
      pct: null,
      pctLabel: '—',
      usedShort: '97.3k',
      limitShort: '—',
      tail: 'used',
      exact: '97,280 tokens',
    });
  });
});
