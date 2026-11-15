// A text sink next to the attachment sink (`attachments.ts`): features that hold text for a chat's composer insert it
// here. The terminal's "Add selection to chat" uses it. A composer registers itself with `Composer`'s `sinkKey`, which
// for a reply composer is the chat id.

const sinks = new Map<string, (text: string) => void>();

export function registerTextSink(key: string, insert: (text: string) => void): () => void {
  sinks.set(key, insert);
  return () => {
    if (sinks.get(key) === insert) sinks.delete(key);
  };
}

/** Inserts `text` into the chat's composer. False when no composer is mounted for it. */
export function insertComposerText(key: string, text: string): boolean {
  const insert = sinks.get(key);
  if (!insert) return false;
  insert(text);
  return true;
}
