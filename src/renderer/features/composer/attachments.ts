// Composer attachment state (S7.11, S7.12): immediate upload, per-file status, removal and the image-drop rule.

import { IMAGE_MIME_TYPES, LIMITS } from '@shared/constants';
import { ERROR_DEFAULTS } from '@shared/errors';
import type { AttachmentRef } from '@shared/types';
import { useCallback, useRef, useState } from 'react';
import { type ApiClient, ApiError } from '../../lib/api-client';
import type { DraftAttachment } from './AttachmentChips';

export const IMAGE_UNSUPPORTED_MESSAGE = 'This model does not support image input';

const isImageFile = (file: File) => (IMAGE_MIME_TYPES as readonly string[]).includes(file.type);

export interface AddResult {
  /** Images were refused because the selected model has no image input. */
  rejectedImages: boolean;
}

export function useDraftAttachments(api: ApiClient, supportsImages: boolean) {
  const [items, setItems] = useState<DraftAttachment[]>([]);
  const itemsRef = useRef<DraftAttachment[]>([]);
  /** Keys removed while their upload was still running: the finished upload is deleted again. */
  const discarded = useRef(new Set<string>());
  const supportsImagesRef = useRef(supportsImages);
  supportsImagesRef.current = supportsImages;

  const commit = useCallback((next: DraftAttachment[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);
  const patch = useCallback(
    (key: string, f: (a: DraftAttachment) => DraftAttachment) =>
      commit(itemsRef.current.map((a) => (a.key === key ? f(a) : a))),
    [commit],
  );

  const upload = useCallback(
    async (key: string, file: File) => {
      try {
        const ref: AttachmentRef = await api.uploadAttachment(file);
        if (discarded.current.delete(key)) {
          void api.deleteAttachment(ref.id).catch(() => {});
          return;
        }
        patch(key, (a) => ({ ...a, status: 'ready', ref, isImage: ref.kind === 'image', size: ref.size }));
      } catch (err) {
        if (discarded.current.delete(key)) return;
        const message = err instanceof ApiError ? err.info.message : "Couldn't upload this file.";
        patch(key, (a) => ({ ...a, status: 'error', error: message }));
      }
    },
    [api, patch],
  );

  const add = useCallback(
    (files: File[]): AddResult => {
      let rejectedImages = false;
      const added: DraftAttachment[] = [];
      let live = itemsRef.current.filter((a) => a.status !== 'error').length;
      for (const file of files) {
        const isImage = isImageFile(file);
        if (isImage && !supportsImagesRef.current) {
          rejectedImages = true;
          continue;
        }
        const key = crypto.randomUUID();
        const base = { key, name: file.name, size: file.size, isImage };
        let error: string | undefined;
        if (live >= LIMITS.attachmentsPerMessage) {
          error = `Up to ${LIMITS.attachmentsPerMessage} files per message.`;
        } else if (isImage && file.size > LIMITS.imageAttachmentBytes) {
          error = ERROR_DEFAULTS.file_too_large.message;
        }
        if (error) {
          added.push({ ...base, status: 'error', error });
          continue;
        }
        live++;
        added.push({ ...base, status: 'uploading' });
        void upload(key, file);
      }
      if (added.length > 0) commit([...itemsRef.current, ...added]);
      return { rejectedImages };
    },
    [commit, upload],
  );

  const discard = useCallback(
    (list: DraftAttachment[]) => {
      for (const a of list) {
        if (a.status === 'uploading') discarded.current.add(a.key);
        else if (a.ref) void api.deleteAttachment(a.ref.id).catch(() => {});
      }
    },
    [api],
  );

  const remove = useCallback(
    (key: string) => {
      const target = itemsRef.current.find((a) => a.key === key);
      if (!target) return;
      discard([target]);
      commit(itemsRef.current.filter((a) => a.key !== key));
    },
    [commit, discard],
  );

  /** Removes (and deletes on the server) every image; returns how many were removed. */
  const removeImages = useCallback((): number => {
    const images = itemsRef.current.filter((a) => a.isImage);
    if (images.length === 0) return 0;
    discard(images);
    commit(itemsRef.current.filter((a) => !a.isImage));
    return images.length;
  }, [commit, discard]);

  /** Empties the composer after a send (the files now belong to the message: nothing is deleted). */
  const take = useCallback((): DraftAttachment[] => {
    const current = itemsRef.current;
    commit([]);
    return current;
  }, [commit]);

  const restore = useCallback((previous: DraftAttachment[]) => commit([...previous, ...itemsRef.current]), [commit]);

  return {
    items,
    uploading: items.some((a) => a.status === 'uploading'),
    ready: items.filter((a) => a.status === 'ready' && a.ref),
    add,
    remove,
    removeImages,
    take,
    restore,
  };
}
