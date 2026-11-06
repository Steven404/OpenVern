import { DEFAULT_MODEL, IMAGE_ACCEPT, TEXT_ACCEPT } from '@shared/constants';
import { ERROR_DEFAULTS, errorInfo } from '@shared/errors';
import type { ChatSummary } from '@shared/types';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api-client';
import { MockApiClient } from '../../lib/mock-api-client';
import { useRunsStore } from '../../stores/runs';
import { useUiStore } from '../../stores/ui';
import { Conversation } from '../conversation';
import { IMAGE_UNSUPPORTED_MESSAGE } from './attachments';
import { ReplyComposer } from './ReplyComposer';
import { installDomStubs, renderWithProviders, resetStores } from './test-utils';

beforeAll(installDomStubs);
beforeEach(resetStores);
afterEach(cleanup);

const VISION = 'Claude Sonnet 5.5';
const NO_VISION = 'DeepSeek V3.2';

async function setup(opts: { delayMs?: number; keyConfigured?: boolean } = {}) {
  const api = new MockApiClient({ delayMs: 0, ...opts });
  const chat: ChatSummary = (await api.listChats())[0] as ChatSummary;
  return { api, chat };
}

const textarea = () => screen.getByLabelText('Message') as HTMLTextAreaElement;
const fileInput = () => screen.getByTestId('file-input') as HTMLInputElement;
const type = (text: string) => fireEvent.change(textarea(), { target: { value: text } });
const sendButton = () => screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement;

async function waitForIdle(chatId: string) {
  await waitFor(() => expect(useRunsStore.getState().runs[chatId]).toBeUndefined());
}

async function pickModel(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: /^Model:/ }));
  fireEvent.click(await screen.findByRole('option', { name: new RegExp(name) }));
}

function upload(file: File) {
  fireEvent.change(fileInput(), { target: { files: [file] } });
}
const png = () => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'pic.png', { type: 'image/png' });
const txt = () => new File(['hello'], 'notes.txt', { type: 'text/plain' });

describe('send keys', () => {
  it('Enter sends, Shift+Enter does not, empty input does not', async () => {
    const { api, chat } = await setup();
    const send = vi.spyOn(api, 'sendMessage');
    renderWithProviders(<ReplyComposer chat={chat} />, { api });

    fireEvent.keyDown(textarea(), { key: 'Enter' }); // empty
    expect(send).not.toHaveBeenCalled();

    type('hello there');
    fireEvent.keyDown(textarea(), { key: 'Enter', shiftKey: true });
    expect(send).not.toHaveBeenCalled();
    expect(textarea().value).toBe('hello there');

    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe(chat.id);
    expect(send.mock.calls[0]?.[1]).toEqual({
      text: 'hello there',
      attachmentIds: [],
      model: chat.model,
      effort: chat.effort,
    });
    expect(textarea().value).toBe('');
    await waitForIdle(chat.id);
  });

  it('does not send while an IME is composing', async () => {
    const { api, chat } = await setup();
    const send = vi.spyOn(api, 'sendMessage');
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    type('にほんご');
    fireEvent.keyDown(textarea(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(textarea(), { key: 'Enter', keyCode: 229 });
    expect(send).not.toHaveBeenCalled();
    expect(textarea().value).toBe('にほんご');
  });

  it('does not send while a run is active', async () => {
    const { api, chat } = await setup({ delayMs: 5 });
    const send = vi.spyOn(api, 'sendMessage');
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    type('first');
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    await screen.findByRole('button', { name: 'Stop' });
    type('second');
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(textarea().value).toBe('second');
    await waitForIdle(chat.id);
  });
});

describe('stop', () => {
  it('turns the send button into Stop while streaming and saves the partial reply as stopped', async () => {
    const { api, chat } = await setup({ delayMs: 5 });
    renderWithProviders(
      <>
        <Conversation chatId={chat.id} />
        <ReplyComposer chat={chat} />
      </>,
      { api },
    );
    await screen.findByText(/That shape is right/);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    type('write something long');
    fireEvent.keyDown(textarea(), { key: 'Enter' });

    const stop = await screen.findByRole('button', { name: 'Stop' });
    expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull();
    await waitFor(() => expect(screen.getAllByTestId('assistant-turn').length).toBeGreaterThan(1));
    await act(async () => {
      fireEvent.click(stop);
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());
    await waitFor(() => expect(useRunsStore.getState().runs[chat.id]).toMatchObject({ status: 'idle', stopped: true }));
    expect((await api.getChat(chat.id)).messages.at(-1)).toMatchObject({ role: 'assistant', status: 'stopped' });
    expect(await screen.findAllByTestId('stopped-label')).toHaveLength(1);
  });
});

describe('stop during a tool run', () => {
  it('stop during a tool run shows Stopped with Retry and keeps Send enabled', async () => {
    const { api, chat } = await setup({ delayMs: 5 });
    renderWithProviders(
      <>
        <Conversation chatId={chat.id} />
        <ReplyComposer chat={chat} />
      </>,
      { api },
    );
    await screen.findByText(/That shape is right/);
    type('use a tool');
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    await waitFor(() => expect(screen.getAllByTestId('tool-row').at(-1)?.getAttribute('data-state')).toBe('running'), {
      timeout: 5000,
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    });
    await waitFor(() => expect(useRunsStore.getState().runs[chat.id]?.status).toBe('idle'));
    expect(await screen.findAllByTestId('stopped-label')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    type('next');
    expect(sendButton().disabled).toBe(false);
  });
});

describe('attachments', () => {
  it('opens the file picker from the attach menu ("Add files")', async () => {
    const { api, chat } = await setup();
    const click = vi.spyOn(HTMLInputElement.prototype, 'click');
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Attach file' }), { key: 'Enter' });
    const item = await screen.findByRole('menuitem', { name: 'Add files' });
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
    fireEvent.click(item);
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it('accept follows the model: text + images for vision models, text only otherwise', async () => {
    const { api, chat } = await setup();
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await screen.findByRole('button', { name: `Model: ${VISION}` });
    expect(fileInput().multiple).toBe(true);
    expect(fileInput().accept).toBe(`${TEXT_ACCEPT},${IMAGE_ACCEPT}`);

    await pickModel(NO_VISION);
    await waitFor(() => expect(fileInput().accept).toBe(TEXT_ACCEPT));
    expect(fileInput().accept).not.toContain('image/');

    await pickModel(VISION);
    await waitFor(() => expect(fileInput().accept).toBe(`${TEXT_ACCEPT},${IMAGE_ACCEPT}`));
  });

  it('uploads immediately: chip spinner, send disabled until ready, then ready chip', async () => {
    const { api, chat } = await setup({ delayMs: 20 });
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await screen.findByRole('button', { name: `Model: ${VISION}` });
    upload(txt());
    const chip = await screen.findByTestId('attachment-chip');
    expect(chip.getAttribute('data-status')).toBe('uploading');
    expect(within(chip).getByTestId('spinner')).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
    await waitFor(() => expect(screen.getByTestId('attachment-chip').getAttribute('data-status')).toBe('ready'));
    expect(screen.getByText('notes.txt')).toBeTruthy();
    expect(sendButton().disabled).toBe(false); // an attachment alone is enough to send
    fireEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }));
    expect(screen.queryByTestId('attachment-chip')).toBeNull();
  });

  it('shows server rejections on the chip in the danger colour', async () => {
    const { api, chat } = await setup();
    vi.spyOn(api, 'uploadAttachment').mockRejectedValueOnce(new ApiError(errorInfo('unsupported_file'), 415));
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    upload(new File(['x'], 'archive.zip', { type: 'application/zip' }));
    const chip = await screen.findByTestId('attachment-chip');
    await waitFor(() => expect(chip.getAttribute('data-status')).toBe('error'));
    expect(within(chip).getByText(ERROR_DEFAULTS.unsupported_file.message).className).toContain('text-danger');
  });

  it('sends the uploaded attachment ids with the message', async () => {
    const { api, chat } = await setup();
    const send = vi.spyOn(api, 'sendMessage');
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await screen.findByRole('button', { name: `Model: ${VISION}` });
    upload(txt());
    await waitFor(() => expect(screen.getByTestId('attachment-chip').getAttribute('data-status')).toBe('ready'));
    type('see file');
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(send.mock.calls[0]?.[1].attachmentIds).toHaveLength(1);
    expect(screen.queryByTestId('attachment-chip')).toBeNull();
    await waitForIdle(chat.id);
  });
});

describe('model switch rule (S7.12)', () => {
  async function withImage() {
    const { api, chat } = await setup();
    const del = vi.spyOn(api, 'deleteAttachment');
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await screen.findByRole('button', { name: `Model: ${VISION}` });
    upload(png());
    await waitFor(() => expect(screen.getByTestId('attachment-chip').getAttribute('data-status')).toBe('ready'));
    expect(within(screen.getByTestId('attachment-chip')).getByRole('img').getAttribute('src')).toBeTruthy();
    return { api, chat, del };
  }

  it('removes images and shows the exact red message when switching to a model without image input', async () => {
    const { del } = await withImage();
    await pickModel(NO_VISION);
    await waitFor(() => expect(screen.queryByTestId('attachment-chip')).toBeNull());
    const notice = screen.getByTestId('image-notice');
    expect(notice.textContent).toBe('This model does not support image input');
    expect(IMAGE_UNSUPPORTED_MESSAGE).toBe('This model does not support image input');
    expect(notice.className).toContain('text-danger');
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('keeps non-image files and shows no message when only text is attached', async () => {
    const { api, chat } = await setup();
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await screen.findByRole('button', { name: `Model: ${VISION}` });
    upload(txt());
    await waitFor(() => expect(screen.getByTestId('attachment-chip').getAttribute('data-status')).toBe('ready'));
    await pickModel(NO_VISION);
    await waitFor(() => expect(fileInput().accept).toBe(TEXT_ACCEPT));
    expect(screen.getAllByTestId('attachment-chip')).toHaveLength(1);
    expect(screen.queryByTestId('image-notice')).toBeNull();
  });

  it.each([
    ['a vision model', VISION],
    ['a non-vision model', NO_VISION],
  ])('attaches an image/svg+xml file as text with %s', async (_label, model) => {
    const { api, chat } = await setup();
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await screen.findByRole('button', { name: `Model: ${VISION}` });
    if (model === NO_VISION) {
      await pickModel(NO_VISION);
      await waitFor(() => expect(fileInput().accept).toBe(TEXT_ACCEPT));
    }
    upload(new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }));
    const chip = await screen.findByTestId('attachment-chip');
    await waitFor(() => expect(chip.getAttribute('data-status')).toBe('ready'));
    expect(screen.queryByTestId('image-notice')).toBeNull();
    expect(within(chip).queryByRole('img')).toBeNull();
  });

  it('clears the message on the next model change', async () => {
    await withImage();
    await pickModel(NO_VISION);
    await screen.findByTestId('image-notice');
    await pickModel(VISION);
    await waitFor(() => expect(screen.queryByTestId('image-notice')).toBeNull());
  });

  it('clears the message when the next file is added', async () => {
    await withImage();
    await pickModel(NO_VISION);
    await screen.findByTestId('image-notice');
    upload(txt());
    await waitFor(() => expect(screen.queryByTestId('image-notice')).toBeNull());
  });

  it('clears the message on the next send', async () => {
    const { chat } = await withImage();
    await pickModel(NO_VISION);
    await screen.findByTestId('image-notice');
    type('go on');
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    await waitFor(() => expect(screen.queryByTestId('image-notice')).toBeNull());
    await waitForIdle(chat.id);
  });

  it('refuses an image picked while the model has no image input, with the same message', async () => {
    const { api, chat } = await setup();
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await screen.findByRole('button', { name: `Model: ${VISION}` });
    await pickModel(NO_VISION);
    await waitFor(() => expect(fileInput().accept).toBe(TEXT_ACCEPT));
    upload(png());
    expect((await screen.findByTestId('image-notice')).textContent).toBe(IMAGE_UNSUPPORTED_MESSAGE);
    expect(screen.queryByTestId('attachment-chip')).toBeNull();
  });
});

describe('model picker', () => {
  it('shows the name without the provider prefix and lists models with context and badges', async () => {
    const { api, chat } = await setup();
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    const trigger = await screen.findByRole('button', { name: `Model: ${VISION}` });
    expect(trigger.textContent).toBe(VISION);
    fireEvent.click(trigger);
    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(7);
    const gemma = screen.getByRole('option', { name: /Gemma 3 4B/ });
    expect(gemma.textContent).toContain('Google');
    expect(gemma.textContent).toContain('131K');
    expect(gemma.textContent).toContain('Vision');
    expect(gemma.textContent).not.toContain('Tools');
    expect(screen.getByRole('option', { name: /GPT-5.5/ }).textContent).toContain('1.05M');
    expect(screen.getByRole('option', { name: /Claude Haiku 5.5/ }).textContent).toContain('Tools');
    // The sample's "limit unknown" model (F1): no context figure in the picker.
    expect(screen.getByRole('option', { name: /Auto Router/ }).textContent).not.toMatch(/\d+(?:\.\d+)?[KM]/);
  });

  it('filters by name and id', async () => {
    const { api, chat } = await setup();
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    fireEvent.click(await screen.findByRole('button', { name: /^Model:/ }));
    const search = await screen.findByLabelText('Search models');
    fireEvent.change(search, { target: { value: 'deepseek' } });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    fireEvent.change(search, { target: { value: 'openai/gpt' } });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    expect(screen.getByRole('option', { name: /GPT-5.5/ })).toBeTruthy();
  });

  it('choosing a model updates the composer and persists lastModel', async () => {
    const { api, chat } = await setup();
    const update = vi.spyOn(api, 'updateSettings');
    const send = vi.spyOn(api, 'sendMessage');
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await pickModel('Claude Haiku 5.5');
    expect(update).toHaveBeenCalledWith({ lastModel: 'anthropic/claude-haiku-5.5' });
    expect(screen.getByRole('button', { name: 'Model: Claude Haiku 5.5' })).toBeTruthy();
    type('hi');
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(send.mock.calls[0]?.[1].model).toBe('anthropic/claude-haiku-5.5');
    await waitForIdle(chat.id);
  });
});

describe('notices (S7.14)', () => {
  it('without a key: notice + Open settings, send disabled, trigger reads "Add API key"', async () => {
    const { api, chat } = await setup({ keyConfigured: false });
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    const notice = await screen.findByTestId('no-key-notice');
    expect(notice.textContent).toContain('Add your OpenRouter API key to start chatting.');
    type('hello');
    expect(sendButton().disabled).toBe(true);
    fireEvent.click(within(notice).getByRole('button', { name: 'Open settings' }));
    expect(useUiStore.getState().settingsOpen).toBe(true);
    useUiStore.setState({ settingsOpen: false });
    fireEvent.click(screen.getByRole('button', { name: 'Add API key' }));
    expect(useUiStore.getState().settingsOpen).toBe(true);
  });

  it("project chat with a model without tools: muted 'can't use tools' notice", async () => {
    const { api } = await setup();
    const project = (await api.listProjects())[0];
    const chat = await api.createChat({ projectId: project?.id ?? null, model: 'google/gemma-3-4b-it' });
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    const notice = await screen.findByTestId('no-tools-notice');
    expect(notice.textContent).toBe("This model can't use tools, so it won't read your project files.");
    expect(notice.className).toContain('text-text-muted');
    await pickModel(VISION);
    await waitFor(() => expect(screen.queryByTestId('no-tools-notice')).toBeNull());
  });

  it('no tools notice only for project chats', async () => {
    const { api } = await setup();
    const chat = await api.createChat({ projectId: null, model: 'google/gemma-3-4b-it' });
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await screen.findByRole('button', { name: /Gemma 3 4B/ });
    expect(screen.queryByTestId('no-tools-notice')).toBeNull();
  });

  it('shows the reply placeholder and the hint', async () => {
    const { api, chat } = await setup();
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    expect(textarea().placeholder).toBe('Reply to OpenVern…');
    expect(textarea().rows).toBe(2);
    expect(screen.getByText('Enter to send · Shift + Enter for a new line')).toBeTruthy();
    void DEFAULT_MODEL;
  });
});

// ── F3: reasoning effort picker ──

const effortTrigger = () => screen.queryByRole('button', { name: /^Effort:/ });

/** Opens the effort menu from the keyboard (jsdom has no pointer events), like `openMenu` in the app tests. */
function openEffortMenu() {
  const trigger = screen.getByRole('button', { name: /^Effort:/ });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
}

async function chooseEffort(name: string | RegExp) {
  openEffortMenu();
  fireEvent.click(await screen.findByRole('menuitemradio', { name }));
}

/** Two chats in one mounted composer, switched with "Next chat" (the composer stays mounted across chats). */
function Switcher({ chats }: { chats: ChatSummary[] }) {
  const [index, setIndex] = useState(0);
  const chat = chats[index] as ChatSummary;
  return (
    <>
      <button type="button" onClick={() => setIndex((i) => (i + 1) % chats.length)}>
        Next chat
      </button>
      <ReplyComposer chat={chat} />
    </>
  );
}

describe('effort picker (F3)', () => {
  it('is shown for a model with reasoning and hidden for one without, and follows a model switch', async () => {
    const { api, chat } = await setup();
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await screen.findByRole('button', { name: `Model: ${VISION}` });
    expect(await screen.findByRole('button', { name: /^Effort:/ })).toBeTruthy();

    await pickModel(NO_VISION);
    await waitFor(() => expect(effortTrigger()).toBeNull());

    await pickModel(VISION);
    expect(await screen.findByRole('button', { name: /^Effort:/ })).toBeTruthy();
  });

  it('a chat on a model without reasoning never shows the picker', async () => {
    const { api } = await setup();
    const plain = await api.createChat({ projectId: null, model: 'deepseek/deepseek-v3.2' });
    renderWithProviders(<ReplyComposer chat={plain} />, { api });
    await screen.findByRole('button', { name: `Model: ${NO_VISION}` });
    expect(effortTrigger()).toBeNull();
  });

  it('lists Default plus the model’s published levels in order, with Default checked first', async () => {
    const { api, chat } = await setup();
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await screen.findByRole('button', { name: /^Effort:/ });
    openEffortMenu();
    const items = await screen.findAllByRole('menuitemradio');
    // Claude Sonnet 5.5 publishes low…max (no none/minimal); Default is prepended.
    expect(items).toHaveLength(6);
    // Name and description are asserted separately: joined text would break Radix's typeahead.
    const [def, low, medium, high, xhigh, max] = items;
    expect(within(def as HTMLElement).getByText('Default')).toBeTruthy();
    expect(within(def as HTMLElement).getByText('Model default: High')).toBeTruthy();
    expect([low, medium, high, xhigh, max].map((i) => i?.textContent)).toEqual([
      'Low',
      'Medium',
      'High',
      'Extra high',
      'Max',
    ]);
    expect(items[0]?.getAttribute('aria-checked')).toBe('true');
  });

  it('the trigger title is "Reasoning effort" and the menu is described by the hint', async () => {
    const { api, chat } = await setup();
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    const trigger = await screen.findByRole('button', { name: /^Effort:/ });
    expect(trigger.getAttribute('title')).toBe('Reasoning effort');

    openEffortMenu();
    const menu = await screen.findByRole('menu');
    const hint = screen.getByText('Higher effort thinks longer and costs more.');
    expect(menu.getAttribute('aria-describedby')).toBe(hint.id);
    expect(document.getElementById(hint.id)).toBe(hint);
  });

  it('is hidden while the model list is still missing', async () => {
    const { api, chat } = await setup();
    vi.spyOn(api, 'listModels').mockReturnValue(new Promise(() => {}));
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await screen.findByRole('button', { name: /^Model:/ });
    expect(effortTrigger()).toBeNull();
  });

  it('is hidden when the model list fails to load', async () => {
    const { api, chat } = await setup();
    vi.spyOn(api, 'listModels').mockRejectedValue(new Error('boom'));
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    fireEvent.click(await screen.findByRole('button', { name: /^Model:/ }));
    expect(await screen.findByText('boom')).toBeTruthy();
    expect(effortTrigger()).toBeNull();
  });

  it('is hidden for a listed model that lacks supportsReasoning', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const chat = await api.createChat({ projectId: null, model: 'openai/gpt-5.5' });
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await screen.findByRole('button', { name: 'Model: GPT-5.5' });
    expect(effortTrigger()).toBeNull();
  });

  it('selecting High shows "Effort: High", and the next send carries effort: high', async () => {
    const { api, chat } = await setup();
    const send = vi.spyOn(api, 'sendMessage');
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await screen.findByRole('button', { name: /^Effort:/ });
    await chooseEffort('High');
    expect(await screen.findByRole('button', { name: 'Effort: High' })).toBeTruthy();

    type('hello');
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]).toMatchObject({ effort: 'high' });
    await waitForIdle(chat.id);
  });

  it('choosing an effort persists it as lastEffort, and choosing Default persists null', async () => {
    const { api, chat } = await setup();
    const update = vi.spyOn(api, 'updateSettings');
    renderWithProviders(<ReplyComposer chat={chat} />, { api });
    await screen.findByRole('button', { name: /^Effort:/ });
    await chooseEffort('Max');
    expect(update).toHaveBeenLastCalledWith({ lastEffort: 'max' });
    await chooseEffort(/^Default/);
    expect(update).toHaveBeenLastCalledWith({ lastEffort: null });
  });

  it('a chat starts from its stored effort, and the send carries it', async () => {
    const { api, chat } = await setup();
    const send = vi.spyOn(api, 'sendMessage');
    renderWithProviders(<ReplyComposer chat={{ ...chat, effort: 'low' }} />, { api });
    expect(await screen.findByRole('button', { name: 'Effort: Low' })).toBeTruthy();
    type('hello');
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(send.mock.calls[0]?.[1]).toMatchObject({ effort: 'low' });
    await waitForIdle(chat.id);
  });

  it('the choice stays with its chat and does not leak when switching chats', async () => {
    const api = new MockApiClient({ delayMs: 0 });
    const [a, b] = (await api.listChats()) as ChatSummary[];
    if (!a || !b) throw new Error('seed missing');
    const send = vi.spyOn(api, 'sendMessage');
    renderWithProviders(<Switcher chats={[a, b]} />, { api });

    await screen.findByRole('button', { name: /^Effort:/ });
    await chooseEffort('High'); // chat A
    expect(await screen.findByRole('button', { name: 'Effort: High' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Next chat' })); // chat B has its own, untouched effort
    expect(await screen.findByRole('button', { name: 'Effort: Default' })).toBeTruthy();
    await chooseEffort('Low');
    expect(await screen.findByRole('button', { name: 'Effort: Low' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Next chat' })); // back to chat A
    expect(await screen.findByRole('button', { name: 'Effort: High' })).toBeTruthy();
    type('for A');
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(send.mock.calls[0]?.[0]).toBe(a.id);
    expect(send.mock.calls[0]?.[1]).toMatchObject({ effort: 'high' });
    await waitForIdle(a.id);

    fireEvent.click(screen.getByRole('button', { name: 'Next chat' })); // chat B again
    expect(await screen.findByRole('button', { name: 'Effort: Low' })).toBeTruthy();
    type('for B');
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(send.mock.calls[1]?.[0]).toBe(b.id);
    expect(send.mock.calls[1]?.[1]).toMatchObject({ effort: 'low' });
    await waitForIdle(b.id);
  });
});
