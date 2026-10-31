import { createContext, isValidElement, memo, type ReactNode, useContext, useEffect, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock';

export interface MarkdownProps {
  text: string;
  /** The text is still growing: renders at most once per animation frame, and highlights completed code blocks only. */
  streaming?: boolean;
}

/** Returns `value`, but while `enabled` updates it at most once per animation frame. */
export function useFrameThrottled<T>(value: T, enabled: boolean): T {
  const [shown, setShown] = useState(value);
  const latest = useRef(value);
  latest.current = value;
  const frame = useRef<number | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` only triggers scheduling; the frame reads `latest`
  useEffect(() => {
    if (!enabled) return;
    if (frame.current !== null) return; // a frame is already pending and will read `latest`
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setShown(latest.current);
    });
  }, [value, enabled]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  return enabled ? shown : value;
}

/** Offset where the last, still unclosed code fence starts (`null` when every fence is closed). */
export function findOpenFence(text: string): number | null {
  let open: { char: string; len: number; at: number } | null = null;
  let offset = 0;
  for (const line of text.split('\n')) {
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (m) {
      const run = m[1] as string;
      const char = run.charAt(0);
      if (!open) {
        if (!(char === '`' && (m[2] ?? '').includes('`'))) open = { char, len: run.length, at: offset };
      } else if (char === open.char && run.length >= open.len && (m[2] ?? '').trim() === '') {
        open = null;
      }
    }
    offset += line.length + 1;
  }
  return open ? open.at : null;
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  return '';
}

const headingBase = 'm-0 font-semibold text-text';

/** Offset of the open code fence while streaming (`null` otherwise); lets `pre` leave unfinished blocks plain. */
const OpenFenceContext = createContext<number | null>(null);

function Pre({ node, children }: { node?: { position?: { start: { offset?: number } } }; children?: ReactNode }) {
  const openFenceAt = useContext(OpenFenceContext);
  const child = Array.isArray(children) ? children[0] : children;
  if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
    const lang = /language-(\S+)/.exec(child.props.className ?? '')?.[1] ?? null;
    const start = node?.position?.start.offset;
    const open = openFenceAt !== null && start !== undefined && start >= openFenceAt;
    return <CodeBlock code={textOf(child.props.children)} lang={lang} highlight={!open} />;
  }
  return <pre>{children}</pre>;
}

const components: Components = {
  p: (props) => <p className="m-0" {...strip(props)} />,
  h1: (props) => <h1 className={`${headingBase} text-[1.3em] leading-[1.3]`} {...strip(props)} />,
  h2: (props) => <h2 className={`${headingBase} text-[1.18em] leading-[1.3]`} {...strip(props)} />,
  h3: (props) => <h3 className={`${headingBase} text-[1.08em] leading-[1.35]`} {...strip(props)} />,
  h4: (props) => <h4 className={`${headingBase} text-[1em]`} {...strip(props)} />,
  h5: (props) => <h5 className={`${headingBase} text-[1em]`} {...strip(props)} />,
  h6: (props) => <h6 className={`${headingBase} text-[1em] text-text-muted`} {...strip(props)} />,
  a: ({ node: _n, href, children, ...rest }) => (
    <a
      {...rest}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
    >
      {children}
    </a>
  ),
  ul: ({ node: _n, className, ...rest }) => (
    <ul
      {...rest}
      className={`m-0 flex flex-col gap-1 pl-6 ${className?.includes('contains-task-list') ? 'list-none pl-1' : 'list-disc'}`}
    />
  ),
  ol: ({ node: _n, ...rest }) => <ol {...rest} className="m-0 flex list-decimal flex-col gap-1 pl-6" />,
  li: ({ node: _n, className, ...rest }) => (
    <li
      {...rest}
      className={`pl-1 marker:text-text-faint [&>ol]:mt-1 [&>p]:m-0 [&>ul]:mt-1 ${className?.includes('task-list-item') ? 'flex items-baseline gap-2 pl-0' : ''}`}
    />
  ),
  input: ({ node: _n, ...rest }) => <input {...rest} className="size-3.5 translate-y-0.5 accent-accent" />,
  blockquote: ({ node: _n, ...rest }) => (
    <blockquote {...rest} className="m-0 border-l-2 border-border-hover pl-4 text-text-muted" />
  ),
  hr: () => <hr className="m-0 border-0 border-t border-border-tool" />,
  strong: ({ node: _n, ...rest }) => <strong {...rest} className="font-semibold text-text" />,
  table: ({ node: _n, ...rest }) => (
    <div className="overflow-x-auto">
      <table {...rest} className="w-full border-collapse text-[0.93em]" />
    </div>
  ),
  th: ({ node: _n, ...rest }) => (
    <th {...rest} className="border border-border-tool bg-tool px-3 py-1.5 text-left font-semibold text-text" />
  ),
  td: ({ node: _n, ...rest }) => <td {...rest} className="border border-border-tool px-3 py-1.5 align-top" />,
  pre: Pre,
  code: ({ node: _n, className, children, ...rest }) => (
    <code
      {...rest}
      className={`rounded-[6px] border border-border bg-code px-1.5 py-px font-mono text-[0.88em] text-text-code ${className ?? ''}`}
    >
      {children}
    </code>
  ),
};

/** Removes react-markdown's `node` prop before spreading onto a DOM element. */
function strip<P extends { node?: unknown }>(props: P): Omit<P, 'node'> {
  const { node: _node, ...rest } = props;
  return rest;
}

const remarkPlugins = [remarkGfm];

/** GFM markdown styled from the tokens (S7.4). Links open externally; render is throttled while streaming. */
export const Markdown = memo(function Markdown({ text, streaming = false }: MarkdownProps) {
  const shown = useFrameThrottled(text, streaming);
  const openFenceAt = streaming ? findOpenFence(shown) : null;
  return (
    <OpenFenceContext.Provider value={openFenceAt}>
      <div className="flex min-w-0 flex-col gap-[14px] break-words" data-streaming={streaming || undefined}>
        <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
          {shown}
        </ReactMarkdown>
      </div>
    </OpenFenceContext.Provider>
  );
});
