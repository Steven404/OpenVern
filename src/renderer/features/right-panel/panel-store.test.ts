import { beforeEach, describe, expect, it } from 'vitest';
import { type ChatPanelState, resetFileState, rootKey, usePanelStore } from './panel-store';

const store = () => usePanelStore.getState();
const chat = (id: string) => usePanelStore.getState().chats[id];

beforeEach(() => usePanelStore.setState({ chats: {} }));

function seed(id: string) {
  store().openFile(id, 'README.md');
  store().openSurface(id, 'diff', { path: 'a.ts' });
  store().toggleFolder(id, 'src');
  store().setQuery(id, 'read');
}

describe('rootKey', () => {
  it('names home and projects', () => {
    expect(rootKey(null)).toBe('home');
    expect(rootKey('p1')).toBe('project:p1');
  });
});

describe('bindRoot', () => {
  it('keeps everything and records the root when the chat is unbound', () => {
    seed('c');
    store().openFile('c', 'a.md');
    store().bindRoot('c', 'home');
    expect(chat('c')?.root).toBe('home');
    expect(chat('c')?.tabs).toHaveLength(3);
    expect(chat('c')?.expanded).toEqual({ src: true });
    expect(chat('c')?.query).toBe('read');
  });

  it('is a no-op with the same root', () => {
    store().bindRoot('c', 'home');
    const before = store().chats;
    const state = chat('c');
    store().bindRoot('c', 'home');
    expect(store().chats).toBe(before);
    expect(chat('c')).toBe(state);
  });

  it('drops file state on a different root but keeps the Diff tab, its params and an active Diff', () => {
    seed('c');
    store().bindRoot('c', 'project:a');
    store().show('c', { type: 'file', path: 'README.md' });
    store().bindRoot('c', 'home');
    expect(chat('c')).toMatchObject({
      root: 'home',
      active: null,
      tabs: [{ type: 'surface', id: 'diff' }],
      expanded: {},
      query: '',
      params: { diff: { path: 'a.ts' } },
    });

    store().show('c', { type: 'surface', id: 'diff' });
    store().openFile('c', 'x.md');
    store().show('c', { type: 'surface', id: 'diff' });
    store().bindRoot('c', 'project:b');
    expect(chat('c')?.active).toEqual({ type: 'surface', id: 'diff' });
    expect(chat('c')?.tabs).toEqual([{ type: 'surface', id: 'diff' }]);
  });
});

describe('resetFileState', () => {
  it('is pure', () => {
    const s: ChatPanelState = {
      active: { type: 'file', path: 'a' },
      tabs: [{ type: 'file', path: 'a' }],
      params: {},
      expanded: { src: true },
      query: 'q',
      root: 'home',
    };
    expect(resetFileState(s, 'project:x').tabs).toEqual([]);
    expect(s.tabs).toHaveLength(1);
  });
});

describe('moveChat', () => {
  it('moves the state and deletes the source', () => {
    seed('__draft__');
    const state = chat('__draft__');
    store().moveChat('__draft__', 'new');
    expect(chat('new')).toBe(state);
    expect('__draft__' in store().chats).toBe(false);
  });

  it('does nothing without source state', () => {
    store().openFile('other', 'a.md');
    const before = store().chats;
    store().moveChat('__draft__', 'new');
    expect(store().chats).toBe(before);
  });
});
