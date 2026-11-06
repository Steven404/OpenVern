import { memo, useEffect, useState } from 'react';
import { type HighlightedLine, highlightCode } from './highlight';

export interface CodeBlockProps {
  code: string;
  /** Fence info string, e.g. `ts`. */
  lang?: string | null;
  /** `false` while the block is still being streamed: plain mono text, no Shiki. */
  highlight?: boolean;
}

// Shiki `FontStyle` bit flags.
const ITALIC = 1;
const BOLD = 2;
const UNDERLINE = 4;

function useHighlighted(code: string, lang: string | null | undefined, enabled: boolean) {
  const [lines, setLines] = useState<HighlightedLine[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void highlightCode(code, lang).then((result) => {
      if (!cancelled) setLines(result);
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang, enabled]);
  return enabled ? lines : null;
}

/** Fenced code block: plain mono until highlighted (Shiki loads lazily), horizontal scroll. */
export const CodeBlock = memo(function CodeBlock({ code, lang, highlight = true }: CodeBlockProps) {
  const text = code.replace(/\n$/, '');
  const lines = useHighlighted(text, lang, highlight);
  return (
    <pre className="m-0 overflow-x-auto rounded-[10px] bg-code px-[18px] py-4 font-mono text-[13px] leading-[1.7] text-text-code">
      <code data-language={lang || undefined} data-highlighted={lines ? 'true' : undefined}>
        {lines
          ? lines.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and never reorder
              <span key={i}>
                {line.map((tok, j) => (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional and never reorder
                    key={j}
                    style={{
                      color: tok.color,
                      fontStyle: (tok.fontStyle ?? 0) & ITALIC ? 'italic' : undefined,
                      fontWeight: (tok.fontStyle ?? 0) & BOLD ? 600 : undefined,
                      textDecoration: (tok.fontStyle ?? 0) & UNDERLINE ? 'underline' : undefined,
                    }}
                  >
                    {tok.content}
                  </span>
                ))}
                {i < lines.length - 1 ? '\n' : null}
              </span>
            ))
          : text}
      </code>
    </pre>
  );
});
