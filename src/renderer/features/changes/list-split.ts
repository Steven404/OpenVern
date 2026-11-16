// Pure helpers for the file list's height in the Diff surface and the card's "show all" threshold. The list is capped
// at a fraction (the "list ratio") of the body below the "Review changes" header, so a long proposal scrolls its list
// instead of pushing the diff out of view. No React or DOM here: the component measures, these decide.

export const LIST_RATIO_DEFAULT = 0.35;
/** The list never gets shorter than this, even when the body is small. */
export const LIST_MIN_PX = 96;
/** The diff never gets shorter than this; if both minimums cannot fit, the list minimum wins. */
export const DIFF_MIN_PX = 160;
/** Keyboard step on the resize handle, as a fraction of the body. Shift steps by `KEY_STEP_BIG`. */
export const KEY_STEP = 0.02;
export const KEY_STEP_BIG = 0.1;

/** Cards with more files than this show only `CARD_PREVIEW_ROWS` until the user expands them. */
const CARD_THRESHOLD = 8;
const CARD_PREVIEW_ROWS = 6;

/**
 * The allowed list ratio for a body of `bodyPx` pixels. An unknown body (0 or less, before the first layout) gets a
 * fixed, generous range so the stored ratio still clamps sensibly.
 */
export function listRatioBounds(bodyPx: number): { min: number; max: number } {
  if (bodyPx <= 0) return { min: 0.1, max: 0.8 };
  const min = LIST_MIN_PX / bodyPx;
  let max = 1 - DIFF_MIN_PX / bodyPx;
  if (min > max) max = min;
  return { min, max };
}

/** Clamps a ratio to the bounds for `bodyPx`. A non-finite value (a bad stored string) becomes the default. */
export function clampListRatio(ratio: number, bodyPx: number): number {
  if (!Number.isFinite(ratio)) return LIST_RATIO_DEFAULT;
  const { min, max } = listRatioBounds(bodyPx);
  return Math.min(max, Math.max(min, ratio));
}

/** The ratio a pointer drag of `deltaY` pixels from a list `startListPx` tall lands on. */
export function ratioFromDrag(startListPx: number, deltaY: number, bodyPx: number): number {
  return clampListRatio((startListPx + deltaY) / bodyPx, bodyPx);
}

/** The ratio after a keyboard key on the handle, or `null` when the key is not one the handle handles. */
export function ratioFromKey(ratio: number, key: string, shift: boolean, bodyPx: number): number | null {
  const { min, max } = listRatioBounds(bodyPx);
  const step = shift ? KEY_STEP_BIG : KEY_STEP;
  switch (key) {
    case 'ArrowDown':
      return clampListRatio(ratio + step, bodyPx);
    case 'ArrowUp':
      return clampListRatio(ratio - step, bodyPx);
    case 'Home':
      return min;
    case 'End':
      return max;
    default:
      return null;
  }
}

/**
 * How many rows a card shows. Up to `CARD_THRESHOLD` files, everything; above it, a preview of
 * `CARD_PREVIEW_ROWS` until `expanded`. `hidden` is what the "Show all" button reveals.
 */
export function cardRows(total: number, expanded: boolean): { shown: number; hidden: number } {
  const shown = expanded || total <= CARD_THRESHOLD ? total : CARD_PREVIEW_ROWS;
  return { shown, hidden: total - shown };
}
