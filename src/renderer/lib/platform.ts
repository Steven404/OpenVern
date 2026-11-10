/**
 * Platform detection for keyboard labels (AS-03). Browser-only, so it works in the web dev build and in the sandboxed
 * renderer: no Node or `process` access and no preload bridge. Detection runs per call, never at module load, so
 * tests can pass or stub a navigator.
 */

/** The navigator fields this module reads. Every field is optional so an empty or partial object is safe. */
export interface PlatformNavigator {
  userAgentData?: { platform?: unknown } | null;
  platform?: unknown;
  userAgent?: unknown;
}

/** `navigator` when it exists (browser or Electron renderer), otherwise `undefined` (for example, plain Node). */
function currentNavigator(): PlatformNavigator | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator;
}

/** The first non-blank string value, or `undefined`. Non-string or blank values are ignored. */
function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * True on macOS. Reads `userAgentData.platform` first (Chromium), then `navigator.platform` (`MacIntel`), then the
 * user agent string. The first non-blank source decides. Missing or non-string fields are skipped.
 */
export function isMacPlatform(nav: PlatformNavigator | undefined = currentNavigator()): boolean {
  const uaPlatform = nonBlank(nav?.userAgentData?.platform);
  if (uaPlatform !== undefined) return /^mac/i.test(uaPlatform);
  const platform = nonBlank(nav?.platform);
  if (platform !== undefined) return /^mac/i.test(platform);
  const userAgent = nonBlank(nav?.userAgent);
  return userAgent !== undefined && /Macintosh|Mac OS X/.test(userAgent);
}

/** The primary modifier's name in shortcut hints: `⌘` on macOS, `Ctrl` elsewhere. */
export function modKeyLabel(nav: PlatformNavigator | undefined = currentNavigator()): string {
  return isMacPlatform(nav) ? '⌘' : 'Ctrl';
}
