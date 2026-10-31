import { promises as fs } from 'node:fs';
import { LIMITS } from '@shared/constants';
import { describe, expect, it } from 'vitest';
import { sniffAttachment } from './attachments';
import { dataPaths } from './paths';
import { cleanupTempDirs, makeStorage } from './test-helpers';

cleanupTempDirs();

const bytes = (...b: number[]) => new Uint8Array(b);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10);
const GIF = new TextEncoder().encode('GIF89a\x01\x00');
const WEBP = new Uint8Array([...new TextEncoder().encode('RIFF'), 1, 0, 0, 0, ...new TextEncoder().encode('WEBPVP8 ')]);
const text = (s: string) => new TextEncoder().encode(s);

describe('sniffAttachment', () => {
  it.each([
    ['png', PNG, 'image/png'],
    ['jpeg', JPEG, 'image/jpeg'],
    ['gif', GIF, 'image/gif'],
    ['webp', WEBP, 'image/webp'],
  ])('detects %s by magic bytes regardless of the file name', (_n, data, mime) => {
    expect(sniffAttachment('whatever.txt', data)).toEqual({ kind: 'image', mime });
  });

  it('accepts UTF-8 text, including multibyte, empty files and a BOM', () => {
    expect(sniffAttachment('a.ts', text('const x = "héllo ✓";')).kind).toBe('text');
    expect(sniffAttachment('empty.txt', new Uint8Array()).kind).toBe('text');
    expect(sniffAttachment('bom.txt', bytes(0xef, 0xbb, 0xbf, 0x68, 0x69)).kind).toBe('text');
  });

  it('maps a few extensions to a mime and defaults to text/plain', () => {
    expect(sniffAttachment('README.md', text('# hi')).mime).toBe('text/markdown');
    expect(sniffAttachment('data.JSON', text('{}')).mime).toBe('application/json');
    expect(sniffAttachment('Makefile', text('all:')).mime).toBe('text/plain');
  });

  it('rejects NUL bytes in the first 8 KB, but not later ones', () => {
    expect(() => sniffAttachment('a.bin', bytes(0x61, 0, 0x62))).toThrowError(
      expect.objectContaining({ code: 'unsupported_file' }),
    );
    const late = new Uint8Array(9000).fill(0x61);
    late[8500] = 0;
    expect(sniffAttachment('late.txt', late).kind).toBe('text');
  });

  it('rejects invalid UTF-8 and unsupported binary formats (pdf, zip, bmp)', () => {
    expect(() => sniffAttachment('a.txt', bytes(0xff, 0xfe, 0x41, 0x80))).toThrowError(
      expect.objectContaining({ code: 'unsupported_file' }),
    );
    expect(() => sniffAttachment('a.pdf', text('%PDF-1.7\n\x00\x01'))).toThrowError(
      expect.objectContaining({ code: 'unsupported_file' }),
    );
    expect(() => sniffAttachment('a.zip', bytes(0x50, 0x4b, 3, 4, 0))).toThrowError(
      expect.objectContaining({ code: 'unsupported_file' }),
    );
  });

  it('enforces the size limits at the boundary', () => {
    const atLimit = new Uint8Array(LIMITS.textAttachmentBytes).fill(0x61);
    expect(sniffAttachment('a.txt', atLimit).kind).toBe('text');
    expect(() => sniffAttachment('a.txt', new Uint8Array(LIMITS.textAttachmentBytes + 1).fill(0x61))).toThrowError(
      expect.objectContaining({ code: 'file_too_large' }),
    );
    // Large *binary* stays unsupported rather than "too large".
    expect(() => sniffAttachment('a.bin', new Uint8Array(LIMITS.textAttachmentBytes + 1))).toThrowError(
      expect.objectContaining({ code: 'unsupported_file' }),
    );
    const bigPng = new Uint8Array(LIMITS.imageAttachmentBytes);
    bigPng.set(PNG);
    expect(sniffAttachment('a.png', bigPng).kind).toBe('image');
    const tooBigPng = new Uint8Array(LIMITS.imageAttachmentBytes + 1);
    tooBigPng.set(PNG);
    expect(() => sniffAttachment('a.png', tooBigPng)).toThrowError(expect.objectContaining({ code: 'file_too_large' }));
  });
});

describe('AttachmentsService', () => {
  it('stores bytes + sidecar and returns a ref (no chatId / createdAt)', async () => {
    const { storage, dataDir } = await makeStorage();
    const ref = await storage.attachments.create({ name: 'notes.md', bytes: text('# hello') });
    expect(ref).toEqual({ id: ref.id, name: 'notes.md', mime: 'text/markdown', size: 7, kind: 'text' });
    const paths = dataPaths(dataDir);
    expect(new TextDecoder().decode(await fs.readFile(paths.attachmentBin(ref.id)))).toBe('# hello');
    const sidecar = JSON.parse(await fs.readFile(paths.attachmentMeta(ref.id), 'utf8'));
    expect(sidecar).toMatchObject({ ...ref, chatId: null });
    expect(typeof sidecar.createdAt).toBe('string');
    expect(await storage.attachments.get(ref.id)).toMatchObject({ ...ref, chatId: null });
    expect(new TextDecoder().decode(await storage.attachments.readBytes(ref.id))).toBe('# hello');
  });

  it('stores images byte-for-byte', async () => {
    const { storage } = await makeStorage();
    const ref = await storage.attachments.create({ name: 'pic.png', bytes: PNG });
    expect(ref).toMatchObject({ kind: 'image', mime: 'image/png', size: PNG.length });
    expect([...(await storage.attachments.readBytes(ref.id))]).toEqual([...PNG]);
  });

  it('strips directories from names and falls back for empty ones', async () => {
    const { storage } = await makeStorage();
    expect((await storage.attachments.create({ name: '../../etc/passwd', bytes: text('x') })).name).toBe('passwd');
    expect((await storage.attachments.create({ name: 'C:\\dir\\a.txt', bytes: text('x') })).name).toBe('a.txt');
    expect((await storage.attachments.create({ name: '  ', bytes: text('x') })).name).toBe('attachment');
  });

  it('rejects unsupported and oversized files without leaving files behind', async () => {
    const { storage, dataDir } = await makeStorage();
    await expect(storage.attachments.create({ name: 'a.bin', bytes: bytes(1, 0, 2) })).rejects.toMatchObject({
      code: 'unsupported_file',
    });
    await expect(
      storage.attachments.create({ name: 'big.txt', bytes: new Uint8Array(LIMITS.textAttachmentBytes + 1).fill(0x61) }),
    ).rejects.toMatchObject({ code: 'file_too_large' });
    expect(await fs.readdir(dataPaths(dataDir).attachmentsDir)).toEqual([]);
  });

  it('unknown / unsafe ids give not_found', async () => {
    const { storage } = await makeStorage();
    for (const id of ['nope', '../x']) {
      await expect(storage.attachments.get(id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(storage.attachments.readBytes(id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(storage.attachments.remove(id)).rejects.toMatchObject({ code: 'not_found' });
    }
    await expect(storage.attachments.bindToChat(['nope'], 'c1')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('bindToChat binds, is idempotent per chat, and conflicts across chats (all-or-nothing)', async () => {
    const { storage } = await makeStorage();
    const a = await storage.attachments.create({ name: 'a.txt', bytes: text('a') });
    const b = await storage.attachments.create({ name: 'b.txt', bytes: text('b') });
    const c = await storage.attachments.create({ name: 'c.txt', bytes: text('c') });

    expect(await storage.attachments.bindToChat([a.id, b.id], 'chat1')).toEqual([a, b]);
    expect((await storage.attachments.get(a.id)).chatId).toBe('chat1');
    expect(await storage.attachments.bindToChat([a.id], 'chat1')).toEqual([a]);

    await expect(storage.attachments.bindToChat([c.id, a.id], 'chat2')).rejects.toMatchObject({ code: 'conflict' });
    expect((await storage.attachments.get(c.id)).chatId).toBeNull(); // c untouched
    // An unknown id fails the whole bind too.
    await expect(storage.attachments.bindToChat([c.id, 'nope'], 'chat2')).rejects.toMatchObject({ code: 'not_found' });
    expect((await storage.attachments.get(c.id)).chatId).toBeNull();
  });

  it('remove works for unbound only', async () => {
    const { storage, dataDir } = await makeStorage();
    const a = await storage.attachments.create({ name: 'a.txt', bytes: text('a') });
    const b = await storage.attachments.create({ name: 'b.txt', bytes: text('b') });
    await storage.attachments.bindToChat([b.id], 'chat1');
    await expect(storage.attachments.remove(b.id)).rejects.toMatchObject({ code: 'conflict' });
    await storage.attachments.remove(a.id);
    await expect(storage.attachments.get(a.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(fs.stat(dataPaths(dataDir).attachmentBin(a.id))).rejects.toThrow();
  });

  it('removeForChat deletes only that chat\u2019s attachments', async () => {
    const { storage } = await makeStorage();
    const a = await storage.attachments.create({ name: 'a.txt', bytes: text('a') });
    const b = await storage.attachments.create({ name: 'b.txt', bytes: text('b') });
    const loose = await storage.attachments.create({ name: 'l.txt', bytes: text('l') });
    await storage.attachments.bindToChat([a.id], 'chat1');
    await storage.attachments.bindToChat([b.id], 'chat2');
    await storage.attachments.removeForChat('chat1');
    await expect(storage.attachments.get(a.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await storage.attachments.get(b.id)).chatId).toBe('chat2');
    expect((await storage.attachments.get(loose.id)).chatId).toBeNull();
    await storage.attachments.removeForChat('unknown'); // no-op
  });

  it('cleanupOrphans removes only old unbound attachments (and stray .bin files)', async () => {
    const { storage, dataDir } = await makeStorage();
    const paths = dataPaths(dataDir);
    const oldUnbound = await storage.attachments.create({ name: 'o.txt', bytes: text('o') });
    const oldBound = await storage.attachments.create({ name: 'b.txt', bytes: text('b') });
    const fresh = await storage.attachments.create({ name: 'f.txt', bytes: text('f') });
    await storage.attachments.bindToChat([oldBound.id], 'chat1');

    const backdate = async (id: string) => {
      const meta = JSON.parse(await fs.readFile(paths.attachmentMeta(id), 'utf8'));
      meta.createdAt = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      await fs.writeFile(paths.attachmentMeta(id), JSON.stringify(meta));
    };
    await backdate(oldUnbound.id);
    await backdate(oldBound.id);

    const stray = paths.attachmentBin('stray');
    await fs.writeFile(stray, 'x');
    const longAgo = new Date(Date.now() - 48 * 3600 * 1000);
    await fs.utimes(stray, longAgo, longAgo);

    expect(await storage.attachments.cleanupOrphans()).toBe(2);
    await expect(storage.attachments.get(oldUnbound.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(fs.stat(stray)).rejects.toThrow();
    expect((await storage.attachments.get(oldBound.id)).chatId).toBe('chat1');
    expect((await storage.attachments.get(fresh.id)).id).toBe(fresh.id);
    expect(await storage.attachments.cleanupOrphans()).toBe(0);
    // A custom threshold applies.
    expect(await storage.attachments.cleanupOrphans({ olderThanMs: -1000 })).toBe(1);
  });
});
