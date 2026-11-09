// Row-window math for the virtualised hex viewer. Pure, so it is tested
// without a DOM.
//
// Rows have a fixed height, so the visible window is plain arithmetic. The
// one wrinkle is size: browsers clamp an element's height (Chromium 152 at
// 2^24 = 16,777,216 px), and a 16 MiB dump at 16 bytes/row and 20 px/row
// already needs 21M px; 64 MiB needs 84M px. Past `maxScrollHeight` the
// scrollable area is clamped and the scroll position is mapped proportionally
// onto the real content, so the top and bottom of the buffer are always
// reachable. Below the cap the mapping is 1:1 and scrolling is exactly native.

/**
 * Default ceiling for the scrollable height, under Chromium's 2^24 px clamp.
 * HexView lowers it at runtime if an engine turns out to clamp lower still.
 */
export const MAX_SCROLL_HEIGHT = 15_000_000;

export interface WindowInput {
  rowCount: number;
  rowHeight: number;
  viewportHeight: number;
  scrollTop: number;
  overscan?: number;
  maxScrollHeight?: number;
}

export interface RowWindow {
  /** Height of the scrollable spacer, in px. */
  scrollHeight: number;
  /** First row to render (inclusive). */
  startRow: number;
  /** Last row to render (exclusive). */
  endRow: number;
  /** Where to place `startRow`, in the scroller's coordinate space, in px. */
  top: number;
  /** Content px per scroll px: 1 unless the buffer is past the height cap. */
  scale: number;
}

export function computeWindow({
  rowCount,
  rowHeight,
  viewportHeight,
  scrollTop,
  overscan = 4,
  maxScrollHeight = MAX_SCROLL_HEIGHT,
}: WindowInput): RowWindow {
  const contentHeight = rowCount * rowHeight;
  const scrollHeight = Math.min(contentHeight, maxScrollHeight);
  const maxScrollTop = Math.max(scrollHeight - viewportHeight, 0);
  const maxOffset = Math.max(contentHeight - viewportHeight, 0);
  const scale = maxScrollTop > 0 ? maxOffset / maxScrollTop : 1;

  const clampedTop = Math.min(Math.max(scrollTop, 0), maxScrollTop);
  const offset = clampedTop * scale; // content px at the top of the viewport

  const firstVisible = Math.floor(offset / rowHeight);
  const lastVisible = Math.ceil((offset + viewportHeight) / rowHeight);
  const startRow = Math.max(firstVisible - overscan, 0);
  const endRow = Math.min(lastVisible + overscan, rowCount);

  return {
    scrollHeight,
    startRow,
    endRow: Math.max(endRow, startRow),
    top: clampedTop + (startRow * rowHeight - offset),
    scale,
  };
}

/** Scroll position that puts `row` at the top of the viewport. */
export function scrollTopForRow(
  row: number,
  { rowHeight, scale }: { rowHeight: number; scale: number },
): number {
  return (row * rowHeight) / scale;
}
