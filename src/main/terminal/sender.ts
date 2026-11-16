// Who may drive a terminal (plan T1.5): only the app's own page in the top frame of the main window. The window's
// webContents alone is not enough: a same-origin subframe (an iframe the page ever embeds) sends with the same
// webContents. Structural types, so this is tested without Electron.

/** The parts of Electron's WebFrameMain compared here. */
export interface FrameLike {
  readonly url: string;
  readonly processId: number;
  readonly routingId: number;
}

export interface SenderEventLike<Contents> {
  readonly sender: Contents;
  /** Null when the frame has navigated away or been destroyed since it sent. */
  readonly senderFrame: FrameLike | null;
}

/** The same frame: the same object, or the same render frame (process and routing id). */
export function isSameFrame(a: FrameLike, b: FrameLike): boolean {
  return a === b || (a.processId === b.processId && a.routingId === b.routingId);
}

/**
 * True only when the event comes from `contents` (the main window's webContents), from its top frame, and that frame
 * shows an app URL.
 */
export function isTopFrameAppSender<Contents extends { readonly mainFrame: FrameLike }>(
  event: SenderEventLike<unknown>,
  contents: Contents | null,
  isAppUrl: (url: string) => boolean,
): boolean {
  if (!contents || event.sender !== contents) return false;
  const frame = event.senderFrame;
  return !!frame && isSameFrame(frame, contents.mainFrame) && isAppUrl(frame.url);
}
