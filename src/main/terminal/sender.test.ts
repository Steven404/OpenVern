// The terminal's sender check (plan T1.5; T1 review item 9): only the main window's top frame, showing the app.

import { describe, expect, it } from 'vitest';
import { type FrameLike, isTopFrameAppSender } from './sender';

const isAppUrl = (url: string) => url.startsWith('app://openvern/');

function contentsWith(mainFrame: FrameLike) {
  return { mainFrame };
}

const top: FrameLike = { url: 'app://openvern/#/chat/1', processId: 7, routingId: 1 };

describe('isTopFrameAppSender', () => {
  it('accepts the top frame of the main window showing the app', () => {
    const contents = contentsWith(top);
    expect(isTopFrameAppSender({ sender: contents, senderFrame: top }, contents, isAppUrl)).toBe(true);
    // The same frame through another wrapper object.
    expect(isTopFrameAppSender({ sender: contents, senderFrame: { ...top } }, contents, isAppUrl)).toBe(true);
  });

  it('refuses a same-origin subframe of the main window', () => {
    const contents = contentsWith(top);
    const iframe: FrameLike = { url: 'app://openvern/embedded.html', processId: 7, routingId: 2 };
    expect(isTopFrameAppSender({ sender: contents, senderFrame: iframe }, contents, isAppUrl)).toBe(false);
  });

  it('refuses another webContents, a missing frame, no main window, and a top frame showing another page', () => {
    const contents = contentsWith(top);
    const other = contentsWith(top);
    expect(isTopFrameAppSender({ sender: other, senderFrame: top }, contents, isAppUrl)).toBe(false);
    expect(isTopFrameAppSender({ sender: contents, senderFrame: null }, contents, isAppUrl)).toBe(false);
    expect(isTopFrameAppSender({ sender: contents, senderFrame: top }, null, isAppUrl)).toBe(false);
    const elsewhere: FrameLike = { ...top, url: 'https://example.com/' };
    const navigated = contentsWith(elsewhere);
    expect(isTopFrameAppSender({ sender: navigated, senderFrame: elsewhere }, navigated, isAppUrl)).toBe(false);
  });
});
