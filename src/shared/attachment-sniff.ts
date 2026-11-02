// Attachment content sniffing (plan S1.7). Pure, no Node or DOM APIs, so the server (`core/storage/attachments`)
// and the renderer's MockApiClient make the same decision for the same bytes.

import { LIMITS } from './constants';

export interface SniffResult {
  kind: 'text' | 'image';
  mime: string;
}

export type SniffOutcome =
  | ({ ok: true } & SniffResult)
  | { ok: false; code: 'unsupported_file' | 'file_too_large'; message?: string };

const NUL_SCAN_BYTES = 8 * 1024;

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

/** Lowercased extension without the dot, with `path.extname` semantics (`Makefile`, `.bashrc` → ''). */
function extOf(name: string): string {
  const base = name.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;
export const imageTooLargeMessage = () => `This image is too large. The limit is ${mb(LIMITS.imageAttachmentBytes)}.`;
export const textTooLargeMessage = () =>
  `This file is too large. The limit for text files is ${LIMITS.textAttachmentBytes / 1024} KB.`;

/**
 * Decides whether `bytes` is a supported attachment: known image magic bytes → image; otherwise valid UTF-8 with
 * no NUL in the first 8 KB → text; anything else is `unsupported_file`. Enforces `LIMITS` (`file_too_large`).
 * Cheap checks run first so a huge binary is never fully decoded. The declared MIME type is never consulted.
 */
export function sniffAttachmentBytes(name: string, bytes: Uint8Array): SniffOutcome {
  const mime = sniffImage(bytes);
  if (mime) {
    if (bytes.byteLength > LIMITS.imageAttachmentBytes)
      return { ok: false, code: 'file_too_large', message: imageTooLargeMessage() };
    return { ok: true, kind: 'image', mime };
  }
  if (bytes.subarray(0, NUL_SCAN_BYTES).includes(0)) return { ok: false, code: 'unsupported_file' };
  if (bytes.byteLength > LIMITS.textAttachmentBytes)
    return { ok: false, code: 'file_too_large', message: textTooLargeMessage() };
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, code: 'unsupported_file' };
  }
  return { ok: true, kind: 'text', mime: TEXT_MIME_BY_EXT[extOf(name)] ?? 'text/plain' };
}
