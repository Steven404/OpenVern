// AttachmentsService (plan S1.7): `attachments/<id>.bin` (raw bytes) + `attachments/<id>.json` (metadata sidecar).
// The sidecar is written last, so a sidecar always implies complete bytes.

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { type SniffResult, sniffAttachmentBytes } from '@shared/attachment-sniff';
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
const MAX_NAME_LENGTH = 255;

const notFound = () => new CoreError('not_found', 'Attachment not found.');

export { type SniffResult, sniffImage } from '@shared/attachment-sniff';

/**
 * Decides whether `bytes` is a supported attachment (plan S1.7); the rules live in `@shared/attachment-sniff` so
 * the MockApiClient decides the same way. Throws `unsupported_file` / `file_too_large` as a `CoreError`.
 */
export function sniffAttachment(name: string, bytes: Uint8Array): SniffResult {
  const r = sniffAttachmentBytes(name, bytes);
  if (!r.ok) throw new CoreError(r.code, r.message);
  return { kind: r.kind, mime: r.mime };
}

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
        // Bytes whose sidecar never made it (crash between the two writes). A quarantined sidecar
        // (`<id>.json.corrupt-*`) means the bytes may belong to a bound attachment, so keep them.
        const names = await fs.readdir(paths.attachmentsDir).catch(() => [] as string[]);
        const quarantined = new Set<string>();
        for (const name of names) {
          const at = name.indexOf('.json.corrupt-');
          if (at > 0) quarantined.add(name.slice(0, at));
        }
        for (const name of names) {
          if (!name.endsWith('.bin')) continue;
          const id = name.slice(0, -'.bin'.length);
          if (!SAFE_ID.test(id) || quarantined.has(id) || (await fs.stat(paths.attachmentMeta(id)).catch(() => null)))
            continue;
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
