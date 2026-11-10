import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMacPlatform, modKeyLabel, type PlatformNavigator } from './platform';

// Every case passes an explicit navigator stub, so results never depend on the host or on jsdom's defaults.
// The no-navigator and default-argument cases stub the global and restore it afterwards.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isMacPlatform', () => {
  it.each([
    ['Chromium userAgentData on macOS', { userAgentData: { platform: 'macOS' } }, true],
    ['Chromium userAgentData on Linux', { userAgentData: { platform: 'Linux' } }, false],
    ['navigator.platform on macOS', { platform: 'MacIntel' }, true],
    ['navigator.platform on Linux', { platform: 'Linux x86_64' }, false],
    ['user agent on macOS', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }, true],
    ['user agent on Linux', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' }, false],
  ])('detects the platform from %s', (_source, nav, expected) => {
    expect(isMacPlatform(nav)).toBe(expected);
  });

  it('lets userAgentData decide over contradictory lower sources', () => {
    expect(isMacPlatform({ userAgentData: { platform: 'Linux' }, platform: 'MacIntel', userAgent: 'Macintosh' })).toBe(
      false,
    );
    expect(
      isMacPlatform({ userAgentData: { platform: 'macOS' }, platform: 'Win32', userAgent: 'Windows NT 10.0' }),
    ).toBe(true);
  });

  it('skips blank and non-string sources and uses the next one', () => {
    expect(isMacPlatform({ userAgentData: { platform: '' }, platform: 'MacIntel' })).toBe(true);
    expect(isMacPlatform({ userAgentData: { platform: '   ' }, platform: 'Linux' })).toBe(false);
    expect(isMacPlatform({ userAgentData: { platform: 42 }, platform: 'MacIntel' })).toBe(true);
    expect(isMacPlatform({ platform: '  ', userAgent: 'Mozilla/5.0 (Macintosh)' })).toBe(true);
  });

  it.each([
    ['an empty object', {}],
    ['null fields', { userAgentData: null, platform: null, userAgent: null }],
    ['non-string fields', { userAgentData: { platform: 42 }, platform: {}, userAgent: ['Macintosh'] }],
  ])('treats %s as not macOS', (_case, nav) => {
    expect(isMacPlatform(nav as PlatformNavigator)).toBe(false);
  });

  it('reads the navigator on every call, so nothing is cached', () => {
    const nav: PlatformNavigator = { platform: 'Linux x86_64' };
    expect(isMacPlatform(nav)).toBe(false);
    nav.platform = 'MacIntel';
    expect(isMacPlatform(nav)).toBe(true);
  });

  it('defaults to the global navigator, and to not macOS when there is none', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    expect(isMacPlatform()).toBe(true);
    vi.stubGlobal('navigator', undefined);
    expect(isMacPlatform()).toBe(false);
  });
});

describe('modKeyLabel', () => {
  it('is ⌘ on macOS and Ctrl on other platforms, including when nothing is known', () => {
    expect(modKeyLabel({ platform: 'MacIntel' })).toBe('⌘');
    expect(modKeyLabel({ userAgentData: { platform: 'Linux' } })).toBe('Ctrl');
    expect(modKeyLabel({})).toBe('Ctrl');
  });

  it('falls back to Ctrl when no navigator exists', () => {
    vi.stubGlobal('navigator', undefined);
    expect(modKeyLabel()).toBe('Ctrl');
  });
});
