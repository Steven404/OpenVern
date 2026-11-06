import { cx } from '@renderer/components/ui';
import { type KeyboardEvent, useEffect, useRef } from 'react';
import { getSurfaces, type SurfaceContext, type SurfaceId } from './surfaces';

/** "Open a panel": one row per surface. F / T / D open a row while the launcher has focus. */
export function Launcher({ ctx, onOpen }: { ctx: SurfaceContext; onOpen: (id: SurfaceId) => void }) {
  const ref = useRef<HTMLDivElement>(null);

  // Arriving from the "+" button (focus is inside the panel): keep the keyboard on the launcher.
  useEffect(() => {
    const el = ref.current;
    if (el && document.activeElement && el.closest('#right-panel')?.contains(document.activeElement)) el.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key.toUpperCase();
    const def = getSurfaces().find((d) => d.key === key);
    if (!def) return;
    event.preventDefault();
    if (def.availability(ctx).enabled && def.Component) onOpen(def.id);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the keys are shortcuts for the buttons inside
    <div
      ref={ref}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex flex-1 flex-col justify-center gap-3.5 px-7 pt-6 pb-24 outline-none"
    >
      <h2 className="m-0 mb-1 ml-2.5 text-[15px] font-semibold text-text">Open a panel</h2>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {getSurfaces().map((def) => {
          const { enabled, hint } = def.availability(ctx);
          const disabled = !enabled || !def.Component;
          return (
            <li key={def.id}>
              <button
                type="button"
                disabled={disabled}
                aria-keyshortcuts={def.key}
                title={hint}
                onClick={() => onOpen(def.id)}
                className={cx(
                  'flex min-h-[52px] w-full items-center gap-3 rounded-[8px] px-2.5 py-1.5 text-left text-[14.5px]',
                  disabled
                    ? 'cursor-not-allowed text-text-faint opacity-60'
                    : 'cursor-pointer text-text-secondary hover:bg-overlay-tonal hover:text-text',
                )}
              >
                <span className="inline-flex size-[18px] shrink-0">{def.icon}</span>
                <span className="flex flex-1 flex-col gap-px">
                  <span>{def.label}</span>
                  <span className="text-xs text-text-faint">{hint}</span>
                </span>
                <span className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-[5px] border-0 bg-tool font-mono text-[11px] text-text-muted">
                  {def.key}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
