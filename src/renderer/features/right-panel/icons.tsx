import type { SVGProps } from 'react';

const base: SVGProps<SVGSVGElement> = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};
type P = SVGProps<SVGSVGElement> & { size?: number };

export function RightPanelIcon({ size = 18, ...p }: P) {
  return (
    <svg aria-hidden="true" {...base} width={size} height={size} strokeWidth={1.75} {...p}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M15 4v16" />
    </svg>
  );
}

export function FilesIcon({ size = 14, ...p }: P) {
  return (
    <svg aria-hidden="true" {...base} width={size} height={size} strokeWidth={size > 14 ? 1.7 : 1.8} {...p}>
      <path d="M15 3H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7z" />
      <path d="M15 3v4h4" />
      <path d="M4 7v12a2 2 0 0 0 2 2h9" />
    </svg>
  );
}

export function TerminalIcon({ size = 18, ...p }: P) {
  return (
    <svg aria-hidden="true" {...base} width={size} height={size} strokeWidth={1.7} {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </svg>
  );
}

export function DiffIcon({ size = 18, ...p }: P) {
  return (
    <svg aria-hidden="true" {...base} width={size} height={size} strokeWidth={1.7} {...p}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 12h6M12 9v6M9 17h6" />
    </svg>
  );
}

export function FileIcon({ size = 14, ...p }: P) {
  return (
    <svg aria-hidden="true" {...base} width={size} height={size} strokeWidth={size > 14 ? 1.7 : 1.8} {...p}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

export function XIcon({ size = 12, strokeWidth = 2.4, ...p }: P) {
  return (
    <svg aria-hidden="true" {...base} width={size} height={size} strokeWidth={strokeWidth} {...p}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function PlusIcon({ size = 15, ...p }: P) {
  return (
    <svg aria-hidden="true" {...base} width={size} height={size} strokeWidth={2} {...p}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
