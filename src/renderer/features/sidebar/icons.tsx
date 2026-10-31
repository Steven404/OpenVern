// Icons copied from the design (docs/design/Main.dc.html) so strokes and sizes match exactly.

import type { SVGProps } from 'react';

const base: SVGProps<SVGSVGElement> = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

export function PanelIcon({ size = 18, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg aria-hidden="true" {...base} width={size} height={size} strokeWidth={1.75} {...props}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9 4v16" />
    </svg>
  );
}

export function PlusIcon({ size = 18, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg aria-hidden="true" {...base} width={size} height={size} strokeWidth={1.75} {...props}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function ChevronIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" {...base} width={14} height={14} strokeWidth={2} {...props}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

export function FolderIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" {...base} width={16} height={16} strokeWidth={1.6} {...props}>
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
    </svg>
  );
}

export function GearIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" {...base} width={19} height={19} strokeWidth={1.6} {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
