// The origin the app's own pages are served from. Dev: the Vite dev server; prod: the `app://openvern` protocol.

export const PROD_ORIGIN = 'app://openvern';

/** `scheme://host[:port]` of a URL, or `null` if it does not parse. (`URL.origin` is opaque for custom schemes.) */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

/** URL of the Vite dev server when launched through `electron-vite dev`, otherwise `undefined`. */
export function devRendererUrl(): string | undefined {
  return process.env.ELECTRON_RENDERER_URL || undefined;
}

export function isDev(): boolean {
  return devRendererUrl() !== undefined;
}

/** The single origin the renderer is allowed to live on. */
export function appOrigin(): string {
  const dev = devRendererUrl();
  return (dev && originOf(dev)) || PROD_ORIGIN;
}

export function isAppUrl(url: string): boolean {
  return originOf(url) === appOrigin();
}
