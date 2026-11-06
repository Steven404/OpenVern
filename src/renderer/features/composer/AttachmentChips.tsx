import type { AttachmentRef } from '@shared/types';
import { FileText, X } from 'lucide-react';
import { IconButton, Spinner } from '../../components/ui';
import { useApiClient } from '../../lib/api-context';
import { formatBytes } from './format';

/** A file in the composer: uploading, uploaded (`ref`), or rejected (`error`). */
export interface DraftAttachment {
  key: string;
  name: string;
  size: number;
  isImage: boolean;
  status: 'uploading' | 'ready' | 'error';
  ref?: AttachmentRef;
  error?: string;
}

export function ComposerAttachmentChips({
  items,
  onRemove,
}: {
  items: DraftAttachment[];
  onRemove: (key: string) => void;
}) {
  const api = useApiClient();
  if (items.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="Attachments">
      {items.map((a) => (
        <li
          key={a.key}
          data-testid="attachment-chip"
          data-status={a.status}
          className={`flex max-w-[260px] items-center gap-2 rounded-[8px] bg-overlay-tonal py-1 pr-1 pl-1 ${
            a.status === 'error' ? 'border border-danger' : ''
          }`}
        >
          <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-[8px] bg-bg text-text-muted">
            {a.status === 'uploading' ? (
              <Spinner size={16} label={`Uploading ${a.name}`} />
            ) : a.isImage && a.ref ? (
              <img src={api.attachmentUrl(a.ref.id)} alt={a.name} className="size-10 object-cover" />
            ) : (
              <FileText aria-hidden="true" size={18} />
            )}
          </span>
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-[12.5px] text-text-secondary" title={a.name}>
              {a.name}
            </span>
            {a.status === 'error' ? (
              <span className="truncate text-[11.5px] text-danger" title={a.error}>
                {a.error}
              </span>
            ) : (
              <span className="font-mono text-[11px] text-text-faint">{formatBytes(a.size)}</span>
            )}
          </span>
          <IconButton size="sm" aria-label={`Remove ${a.name}`} onClick={() => onRemove(a.key)}>
            <X aria-hidden="true" size={14} />
          </IconButton>
        </li>
      ))}
    </ul>
  );
}

/** Attachments of a sent user message: images as thumbnails (≤ 240px wide), text files as chips. */
export function SentAttachments({ attachments }: { attachments: AttachmentRef[] }) {
  const api = useApiClient();
  if (attachments.length === 0) return null;
  return (
    <ul className="m-0 mb-2 flex list-none flex-wrap gap-2 p-0" aria-label="Attachments">
      {attachments.map((a) =>
        a.kind === 'image' ? (
          <li key={a.id}>
            <img
              src={api.attachmentUrl(a.id)}
              alt={a.name}
              className="block max-h-[240px] w-auto max-w-[240px] rounded-[8px] object-cover"
            />
          </li>
        ) : (
          <li
            key={a.id}
            className="flex max-w-[260px] items-center gap-2 rounded-[8px] bg-overlay-tonal px-2.5 py-1.5 text-[12.5px] text-text-secondary"
          >
            <FileText aria-hidden="true" size={15} className="shrink-0 text-text-muted" />
            <span className="truncate" title={a.name}>
              {a.name}
            </span>
            <span className="shrink-0 font-mono text-[11px] text-text-faint">{formatBytes(a.size)}</span>
          </li>
        ),
      )}
    </ul>
  );
}
