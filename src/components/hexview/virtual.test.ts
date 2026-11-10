import { describe, expect, it } from "vitest";
import { computeWindow, scrollTopForRow, scrollTopToReveal } from "./virtual";

const base = { rowHeight: 20, viewportHeight: 200, overscan: 2 };

describe("computeWindow", () => {
  it("renders only the visible rows plus overscan at the top", () => {
    const w = computeWindow({ ...base, rowCount: 1000, scrollTop: 0 });
    expect(w.scale).toBe(1);
    expect(w.scrollHeight).toBe(20_000);
    expect(w.startRow).toBe(0);
    expect(w.endRow).toBe(12); // 10 visible + 2 overscan
    expect(w.top).toBe(0);
  });

  it("follows the scroll position 1:1 below the height cap", () => {
    const w = computeWindow({ ...base, rowCount: 1000, scrollTop: 1010 });
    expect(w.startRow).toBe(48); // first visible 50, minus overscan
    expect(w.endRow).toBe(63); // ceil(1210 / 20) = 61, plus overscan
    expect(w.top).toBe(48 * 20);
  });

  it("handles a buffer shorter than the viewport", () => {
    const w = computeWindow({ ...base, rowCount: 3, scrollTop: 0 });
    expect(w.scrollHeight).toBe(60);
    expect(w.startRow).toBe(0);
    expect(w.endRow).toBe(3);
  });

  it("handles an empty buffer", () => {
    const w = computeWindow({ ...base, rowCount: 0, scrollTop: 0 });
    expect(w).toMatchObject({ scrollHeight: 0, startRow: 0, endRow: 0 });
  });

  it("clamps a scroll position past the end", () => {
    const w = computeWindow({ ...base, rowCount: 100, scrollTop: 99_999 });
    expect(w.endRow).toBe(100);
    expect(w.startRow).toBe(88); // last 10 rows, minus overscan
  });

  it("clamps the spacer at the cap and maps scroll proportionally", () => {
    const rowCount = 4 * 1024 * 1024; // 64 MiB at 16 bytes/row
    const maxScrollHeight = 1_000_000;
    const at = (scrollTop: number) =>
      computeWindow({ ...base, rowCount, scrollTop, maxScrollHeight });

    const top = at(0);
    expect(top.scrollHeight).toBe(maxScrollHeight);
    expect(top.scale).toBeGreaterThan(1);
    expect(top.startRow).toBe(0);

    // Scrolled to the very bottom, the last row is on screen.
    const bottom = at(maxScrollHeight - base.viewportHeight);
    expect(bottom.endRow).toBe(rowCount);
    // The window sits inside the spacer, at the viewport.
    expect(bottom.top).toBeGreaterThanOrEqual(0);
    expect(bottom.top).toBeLessThanOrEqual(maxScrollHeight);

    // Halfway down the scrollbar is halfway through the data.
    const mid = at((maxScrollHeight - base.viewportHeight) / 2);
    const visibleRows = base.viewportHeight / base.rowHeight;
    expect(mid.startRow + base.overscan).toBeCloseTo(
      (rowCount - visibleRows) / 2,
      -1,
    );
  });
});

describe("scrollTopForRow", () => {
  it("inverts the window mapping", () => {
    const rowCount = 4 * 1024 * 1024;
    const maxScrollHeight = 1_000_000;
    const { scale } = computeWindow({
      ...base,
      rowCount,
      scrollTop: 0,
      maxScrollHeight,
    });
    const target = 1_234_567;
    const scrollTop = scrollTopForRow(target, { rowHeight: 20, scale });
    const w = computeWindow({ ...base, rowCount, scrollTop, maxScrollHeight });
    // Exact below the cap; within a row above it (float rounding, and the
    // browser rounds scrollTop to device pixels anyway).
    expect(Math.abs(w.startRow + base.overscan - target)).toBeLessThanOrEqual(1);
  });
});

describe("scrollTopToReveal", () => {
  const view = { rowHeight: 20, viewportHeight: 200, scale: 1 };

  it("leaves a row that is already in view alone", () => {
    expect(scrollTopToReveal(5, { ...view, scrollTop: 0 })).toBeNull();
    expect(scrollTopToReveal(9, { ...view, scrollTop: 0 })).toBeNull();
  });

  it("scrolls a row above the viewport to the top edge", () => {
    expect(scrollTopToReveal(3, { ...view, scrollTop: 200 })).toBe(60);
  });

  it("scrolls a row below the viewport to the bottom edge", () => {
    expect(scrollTopToReveal(10, { ...view, scrollTop: 0 })).toBe(20);
    expect(scrollTopToReveal(50, { ...view, scrollTop: 0 })).toBe(820);
  });

  it("maps through the scale past the height cap", () => {
    expect(scrollTopToReveal(100, { ...view, scrollTop: 0, scale: 2 })).toBe(910);
    expect(scrollTopToReveal(0, { ...view, scrollTop: 910, scale: 2 })).toBe(0);
  });
});
