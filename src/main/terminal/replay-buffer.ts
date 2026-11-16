// The raw output one session keeps for replay (docs/terminal-plan.md §2, "Reload survival"): the most recent
// `maxBytes` of what the shell wrote, measured in UTF-8 bytes, exactly as it was written. Main never interprets it.
//
// When older output has to go, the buffer drops at least the excess from the start and then everything up to and
// including the next line break, so what is kept always starts at the beginning of a line. A cut is only ever made
// just after a `\n`, which is never half of a surrogate pair. When no line break is left to cut at, everything is
// dropped and new output is skipped up to the next line break that arrives.

export interface ReplaySnapshot {
  /** The kept output, oldest first. */
  text: string;
  /** True once any output has been dropped (then `text` starts just after a line break). */
  truncated: boolean;
}

/** Compacts the chunk list once this many dropped entries sit at its head. */
const COMPACT_AT = 1_024;

export class ReplayBuffer {
  private chunks: string[] = [];
  /** Index of the first kept chunk in `chunks`. */
  private head = 0;
  /** UTF-8 bytes of each kept chunk, parallel to `chunks`. */
  private sizes: number[] = [];
  private bytes = 0;
  private truncated = false;
  /** Output was dropped up to a point inside a line: skip new output up to and including the next line break. */
  private seekingLineStart = false;

  constructor(private readonly maxBytes: number) {}

  /** UTF-8 bytes kept. */
  get size(): number {
    return this.bytes;
  }

  append(data: string): void {
    let text = data;
    if (this.seekingLineStart) {
      const lineBreak = text.indexOf('\n');
      if (lineBreak < 0) return;
      this.seekingLineStart = false;
      text = text.slice(lineBreak + 1);
    }
    if (text.length === 0) return;
    const size = Buffer.byteLength(text, 'utf8');
    this.chunks.push(text);
    this.sizes.push(size);
    this.bytes += size;
    if (this.bytes > this.maxBytes) this.trim();
  }

  snapshot(): ReplaySnapshot {
    const text = this.head === 0 ? this.chunks.join('') : this.chunks.slice(this.head).join('');
    return { text, truncated: this.truncated };
  }

  /**
   * Drops everything kept (the renderer crashed, so the output may hold a sequence that crashes the emulator). Later
   * output is kept from the next line break on, as after any other drop.
   */
  clear(): void {
    if (this.bytes > 0) {
      this.truncated = true;
      this.seekingLineStart = true;
    }
    this.chunks = [];
    this.sizes = [];
    this.head = 0;
    this.bytes = 0;
  }

  /** Drops at least `bytes - maxBytes` from the start, then up to and including the next line break. */
  private trim(): void {
    this.truncated = true;
    let excess = this.bytes - this.maxBytes;
    while (this.head < this.chunks.length) {
      const chunk = this.chunks[this.head] ?? '';
      if ((this.sizes[this.head] ?? 0) < excess) {
        // Entirely inside the excess.
        excess -= this.dropHead();
        continue;
      }
      // The excess ends in this chunk: cut just after the first line break at or past it.
      const cut = cutAfterLineBreak(chunk, excess);
      if (cut === null) {
        // None in this chunk, so the next one starts inside a line: its first line break is the cut.
        this.dropHead();
        excess = 0;
        continue;
      }
      // Cut just after a `\n`, so the two parts' byte counts add up to the chunk's.
      if (cut.index === chunk.length) {
        this.dropHead();
      } else {
        this.chunks[this.head] = chunk.slice(cut.index);
        this.sizes[this.head] = (this.sizes[this.head] ?? 0) - cut.bytes;
        this.bytes -= cut.bytes;
      }
      this.compact();
      return;
    }
    // Nothing kept: the cut falls inside a line that has not ended yet.
    this.seekingLineStart = true;
    this.compact();
  }

  private dropHead(): number {
    const size = this.sizes[this.head] ?? 0;
    this.chunks[this.head] = '';
    this.bytes -= size;
    this.head += 1;
    return size;
  }

  private compact(): void {
    if (this.head === this.chunks.length) {
      this.chunks = [];
      this.sizes = [];
      this.head = 0;
    } else if (this.head >= COMPACT_AT && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.sizes = this.sizes.slice(this.head);
      this.head = 0;
    }
  }
}

/**
 * Just after the first `\n` that ends at least `minBytes` UTF-8 bytes into `text`: its UTF-16 index and the UTF-8
 * bytes before it. Null when there is none.
 */
function cutAfterLineBreak(text: string, minBytes: number): { index: number; bytes: number } | null {
  let from = 0;
  let bytes = 0;
  for (;;) {
    const lineBreak = text.indexOf('\n', from);
    if (lineBreak < 0) return null;
    bytes += Buffer.byteLength(text.slice(from, lineBreak + 1), 'utf8');
    from = lineBreak + 1;
    if (bytes >= minBytes) return { index: from, bytes };
  }
}
