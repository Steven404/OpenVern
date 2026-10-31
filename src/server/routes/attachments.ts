// /attachments* (upload, content, delete)

import { ROUTES } from '@shared/api';
import { LIMITS } from '@shared/constants';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { CoreError } from '../../core/errors';
import type { Core } from '../../core/types';
import { errorResponse } from '../http';

/** Multipart framing overhead allowed on top of the largest file (images). Type-specific limits live in S1. */
const MULTIPART_OVERHEAD = 64 * 1024;
const MAX_UPLOAD_BODY = LIMITS.imageAttachmentBytes + MULTIPART_OVERHEAD;

export function attachmentRoutes(core: Core): Hono {
  const r = new Hono();

  r.post(
    ROUTES.attachments,
    // Rejects on `Content-Length`, or while streaming when there is none, without buffering past the limit.
    bodyLimit({
      maxSize: MAX_UPLOAD_BODY,
      onError: (c) =>
        errorResponse(
          c,
          'file_too_large',
          `This file is too large. The limit is ${LIMITS.imageAttachmentBytes / (1024 * 1024)} MB.`,
        ),
    }),
    async (c) => {
      let form: Record<string, unknown>;
      try {
        form = await c.req.parseBody();
      } catch {
        throw new CoreError('invalid_request', 'Expected a multipart/form-data body with a "file" field.');
      }
      const file = form.file;
      if (!(file instanceof File))
        throw new CoreError('invalid_request', 'Expected a multipart/form-data body with a "file" field.');
      if (file.size > LIMITS.imageAttachmentBytes) throw new CoreError('file_too_large');
      const bytes = new Uint8Array(await file.arrayBuffer());
      return c.json(await core.attachments.create({ name: file.name, bytes }));
    },
  );

  r.get(ROUTES.attachmentContent, async (c) => {
    const id = c.req.param('id');
    const meta = await core.attachments.get(id);
    const bytes = await core.attachments.readBytes(id);
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': meta.kind === 'text' ? `${meta.mime}; charset=utf-8` : meta.mime,
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      // Defence in depth: an uploaded .html/.xml must never run script even if opened directly.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      'Content-Disposition': 'inline',
    });
  });

  r.delete(ROUTES.attachment, async (c) => {
    await core.attachments.remove(c.req.param('id'));
    return c.body(null, 204);
  });

  return r;
}
