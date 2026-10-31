// AttachmentsService (plan S1.7): `attachments/<id>.bin` (raw bytes) + `attachments/<id>.json` (metadata sidecar).
// The sidecar is written last, so a sidecar always implies complete bytes.

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LIMITS } from '@shared/constants';
import type { AttachmentRef, Id } from '@shared/types';
import { CoreError } from '../errors';
import type { AttachmentsService, StoredAttachment } from '../types';
import { isNotFound, JsonFile, type StorageLogger, writeFileAtomic } from './json-file';
import { createMutex } from './mutex';
import { type DataPaths, dataPaths } from './paths';
import { attachmentMetaSchema } from './schemas';

export interface AttachmentsServiceOptions {
  /** Absolute data dir (the tree must exist; see `ensureDataDir`). */
  dataDir: string;
  logger?: StorageLogger;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const NUL_SCAN_BYTES = 8 * 1024;
const MAX_NAME_LENGTH = 255;

const notFound = () => new CoreError('not_found', 'Attachment not found.');

export interface SniffResult {
  kind: 'text' | 'image';
  mime: string;
}

const startsWith = (bytes: Uint8Array, sig: readonly number[], offset = 0) =>
  bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);

/** Magic-byte detection of the supported image formats; `null` if not an image. */
export function sniffImage(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  )
    return 'image/gif';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
    return 'image/webp';
  return null;
}

const TEXT_MIME_BY_EXT: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  csv: 'text/csv',
  xml: 'application/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
};

/**
 * Decides whether `bytes` is a supported attachment (plan S1.7): known image magic bytes → image; otherwise
 * valid UTF-8 with no NUL in the first 8 KB → text; anything else throws `unsupported_file`.
 * Enforces `LIMITS` (`file_too_large`). Cheap checks run first so a huge binary is never fully decoded.
 */
export function sniffAttachment(name: string, bytes: Uint8Array): SniffResult {
  const mime = sniffImage(bytes);
  if (mime) {
    if (bytes.byteLength > LIMITS.imageAttachmentBytes) throw new CoreError('file_too_large', imageTooLarge());
    return { kind: 'image', mime };
  }
  if (bytes.subarray(0, NUL_SCAN_BYTES).includes(0)) throw new CoreError('unsupported_file');
  if (bytes.byteLength > LIMITS.textAttachmentBytes) throw new CoreError('file_too_large', textTooLarge());
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CoreError('unsupported_file');
  }
  const ext = path.extname(name).slice(1).toLowerCase();
  return { kind: 'text', mime: TEXT_MIME_BY_EXT[ext] ?? 'text/plain' };
}

const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;
const imageTooLarge = () => `This image is too large. The limit is ${mb(LIMITS.imageAttachmentBytes)}.`;
const textTooLarge = () =>
  `This file is too large. The limit for text files is ${LIMITS.textAttachmentBytes / 1024} KB.`;

/** Strips directories (either separator) and bounds the length; never returns an empty name. */
function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop()?.trim() ?? '';
  return (base || 'attachment').slice(0, MAX_NAME_LENGTH);
}

const toRef = ({ id, name, mime, size, kind }: StoredAttachment): AttachmentRef => ({ id, name, mime, size, kind });

export function createAttachmentsService(opts: AttachmentsServiceOptions): AttachmentsService {
  const paths: DataPaths = dataPaths(opts.dataDir);
  const lock = createMutex();

  const metaFile = (id: Id) => {
    if (!SAFE_ID.test(id)) throw notFound();
    return new JsonFile<StoredAttachment>(paths.attachmentMeta(id), attachmentMetaSchema, { logger: opts.logger });
  };

  async function get(id: Id): Promise<StoredAttachment> {
    const meta = await metaFile(id).read();
    if (!meta) throw notFound();
    return meta;
  }

  async function removeFiles(id: Id): Promise<void> {
    await metaFile(id).delete();
    await fs.rm(paths.attachmentBin(id), { force: true });
  }

  /** Every readable sidecar (corrupt ones are quarantined by `JsonFile` and skipped). */
  async function listAll(): Promise<StoredAttachment[]> {
    const names = await fs.readdir(paths.attachmentsDir).catch(() => [] as string[]);
    const out: StoredAttachment[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (!SAFE_ID.test(id)) continue;
      const meta = await metaFile(id).read();
      if (meta) out.push(meta);
    }
    return out;
  }

  return {
    async create({ name, bytes }) {
      const { kind, mime } = sniffAttachment(name, bytes);
      const meta: StoredAttachment = {
        id: randomUUID(),
        name: cleanName(name),
        mime,
        size: bytes.byteLength,
        kind,
        chatId: null,
        createdAt: new Date().toISOString(),
      };
      await writeFileAtomic(paths.attachmentBin(meta.id), bytes);
      try {
        await metaFile(meta.id).write(meta);
      } catch (err) {
        await fs.rm(paths.attachmentBin(meta.id), { force: true });
        throw err;
      }
      return toRef(meta);
    },

    get,

    async readBytes(id) {
      await get(id);
      try {
        return new Uint8Array(await fs.readFile(paths.attachmentBin(id)));
      } catch (err) {
        if (isNotFound(err)) throw notFound();
        throw err;
      }
    },

    bindToChat(ids, chatId) {
      return lock.run(async () => {
        // Validate everything before changing anything, so a failed bind leaves no partial state.
        const metas = await Promise.all(ids.map((id) => get(id)));
        for (const meta of metas) {
          if (meta.chatId !== null && meta.chatId !== chatId) {
            throw new CoreError('conflict', 'An attachment is already used in another chat.');
          }
        }
        const refs: AttachmentRef[] = [];
        for (const meta of metas) {
          if (meta.chatId !== chatId) await metaFile(meta.id).write({ ...meta, chatId });
          refs.push(toRef(meta));
        }
        return refs;
      });
    },

    remove(id) {
      return lock.run(async () => {
        const meta = await get(id);
        if (meta.chatId !== null) throw new CoreError('conflict', 'This attachment is already part of a message.');
        await removeFiles(id);
      });
    },

    removeForChat(chatId) {
      return lock.run(async () => {
        for (const meta of await listAll()) {
          if (meta.chatId === chatId) await removeFiles(meta.id);
        }
      });
    },

    cleanupOrphans(cleanup = {}) {
      const olderThanMs = cleanup.olderThanMs ?? DAY_MS;
      return lock.run(async () => {
        const cutoff = Date.now() - olderThanMs;
        let removed = 0;
        for (const meta of await listAll()) {
          if (meta.chatId === null && Date.parse(meta.createdAt) < cutoff) {
            await removeFiles(meta.id);
            removed++;
          }
        }
        // Bytes whose sidecar never made it (crash between the two writes) or was quarantined as corrupt.
        const names = await fs.readdir(paths.attachmentsDir).catch(() => [] as string[]);
        for (const name of names) {
          if (!name.endsWith('.bin')) continue;
          const id = name.slice(0, -'.bin'.length);
          if (!SAFE_ID.test(id) || (await fs.stat(paths.attachmentMeta(id)).catch(() => null))) continue;
          const stat = await fs.stat(paths.attachmentBin(id)).catch(() => null);
          if (stat && stat.mtimeMs < cutoff) {
            await fs.rm(paths.attachmentBin(id), { force: true });
            removed++;
          }
        }
        return removed;
      });
    },
  };
}
