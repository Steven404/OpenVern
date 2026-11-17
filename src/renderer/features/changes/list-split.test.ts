import { LIST_RATIO_DEFAULT } from '@shared/constants';
import { describe, expect, it } from 'vitest';
import { cardRows, clampListRatio, HANDLE_PX, listRatioBounds, ratioFromDrag, ratioFromKey } from './list-split';

describe('clampListRatio', () => {
  it('falls back to the default for a non-finite value', () => {
    expect(clampListRatio(Number.NaN, 500)).toBe(0.35);
    expect(clampListRatio(Number.POSITIVE_INFINITY, 500)).toBe(0.35);
    expect(clampListRatio(Number.NEGATIVE_INFINITY, 0)).toBe(LIST_RATIO_DEFAULT);
  });

  it('clamps to the fixed range when the body is not measured yet', () => {
    expect(clampListRatio(0.05, 0)).toBe(0.1);
    expect(clampListRatio(0.95, 0)).toBe(0.8);
    expect(clampListRatio(0.5, 0)).toBe(0.5);
  });

  it('keeps the list at least 96px and the diff at least 160px tall, with the 6px handle between them', () => {
    expect(clampListRatio(0.05, 500)).toBe(96 / 500);
    expect(clampListRatio(0.95, 500)).toBe(1 - (160 + HANDLE_PX) / 500);
    expect(clampListRatio(0.35, 500)).toBe(0.35);
  });

  it('leaves exactly the diff minimum and the handle below the list at its maximum', () => {
    const { max } = listRatioBounds(500);
    expect(HANDLE_PX).toBe(6);
    expect(Math.round((1 - max) * 500)).toBe(160 + HANDLE_PX);
  });

  it('lets the list minimum win when both minimums cannot fit', () => {
    expect(listRatioBounds(200)).toEqual({ min: 96 / 200, max: 96 / 200 });
    expect(clampListRatio(0.1, 200)).toBe(96 / 200);
  });
});

describe('ratioFromDrag', () => {
  it('grows the list when the handle moves down and shrinks it when it moves up', () => {
    expect(ratioFromDrag(175, 50, 500)).toBeCloseTo(0.45);
    expect(ratioFromDrag(175, -50, 500)).toBeCloseTo(0.25);
  });

  it('clamps both ways', () => {
    expect(ratioFromDrag(175, 1000, 500)).toBe(1 - (160 + HANDLE_PX) / 500);
    expect(ratioFromDrag(175, -1000, 500)).toBe(96 / 500);
  });
});

describe('ratioFromKey', () => {
  it('steps by 2% and by 10% with Shift', () => {
    expect(ratioFromKey(0.35, 'ArrowDown', false, 0)).toBeCloseTo(0.37);
    expect(ratioFromKey(0.35, 'ArrowDown', true, 0)).toBeCloseTo(0.45);
    expect(ratioFromKey(0.35, 'ArrowUp', false, 0)).toBeCloseTo(0.33);
    expect(ratioFromKey(0.35, 'ArrowUp', true, 0)).toBeCloseTo(0.25);
  });

  it('jumps to the minimum on Home and the maximum on End', () => {
    expect(ratioFromKey(0.35, 'Home', false, 500)).toBe(96 / 500);
    expect(ratioFromKey(0.35, 'End', false, 500)).toBe(1 - (160 + HANDLE_PX) / 500);
    expect(ratioFromKey(0.35, 'Home', false, 0)).toBe(0.1);
    expect(ratioFromKey(0.35, 'End', false, 0)).toBe(0.8);
  });

  it('returns null for keys the handle does not handle', () => {
    expect(ratioFromKey(0.35, 'Enter', false, 500)).toBeNull();
    expect(ratioFromKey(0.35, 'ArrowLeft', false, 500)).toBeNull();
    expect(ratioFromKey(0.35, 'a', true, 500)).toBeNull();
  });

  it('always stays clamped, and steps from the clamped value it is given', () => {
    expect(ratioFromKey(0.8, 'ArrowDown', true, 0)).toBe(0.8);
    expect(ratioFromKey(0.1, 'ArrowUp', true, 0)).toBe(0.1);
    expect(ratioFromKey(1 - (160 + HANDLE_PX) / 500, 'ArrowDown', false, 500)).toBe(1 - (160 + HANDLE_PX) / 500);
    // A stored 0.8 on a 400px body is shown as its maximum (0.585); one step up from that, not from 0.8.
    expect(ratioFromKey(1 - (160 + HANDLE_PX) / 400, 'ArrowUp', false, 400)).toBeCloseTo(0.565);
  });
});

describe('cardRows', () => {
  it('shows every row up to eight files, and is not collapsible', () => {
    expect(cardRows(8, false)).toEqual({ shown: 8, hidden: 0, collapsible: false });
  });

  it('previews six rows above eight files and counts the rest as hidden', () => {
    expect(cardRows(9, false)).toEqual({ shown: 6, hidden: 3, collapsible: true });
  });

  it('shows every row when expanded, and stays collapsible while above the threshold', () => {
    expect(cardRows(20, true)).toEqual({ shown: 20, hidden: 0, collapsible: true });
  });

  it('is not collapsible once the count drops to the threshold, even when expanded', () => {
    expect(cardRows(5, true)).toEqual({ shown: 5, hidden: 0, collapsible: false });
  });
});
