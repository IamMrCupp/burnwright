import { describe, expect, it } from "vitest";
import {
  canRedo,
  canUndo,
  createEditState,
  fillRange,
  isDirty,
  redo,
  revert,
  undo,
  writeBytes,
} from "./editModel";

const buf = (...values: number[]) => Uint8Array.from(values);

describe("edit model", () => {
  it("starts clean, on the caller's buffer", () => {
    const data = buf(1, 2, 3);
    const s = createEditState(data);
    expect(s.bytes).toBe(data);
    expect(isDirty(s)).toBe(false);
    expect(canUndo(s)).toBe(false);
    expect(canRedo(s)).toBe(false);
  });

  it("writes into a new array and never mutates the original", () => {
    const data = buf(1, 2, 3, 4);
    const s0 = createEditState(data);
    const s1 = writeBytes(s0, 1, [0xaa, 0xbb]);
    expect(Array.from(s1.bytes)).toEqual([1, 0xaa, 0xbb, 4]);
    expect(Array.from(data)).toEqual([1, 2, 3, 4]);
    expect(Array.from(s0.bytes)).toEqual([1, 2, 3, 4]);
    expect(s1.changedCount).toBe(2);
    expect(isDirty(s1)).toBe(true);
  });

  it("keeps the length fixed: writes past the end are clipped", () => {
    const s = writeBytes(createEditState(buf(0, 0, 0)), 2, [7, 8, 9]);
    expect(Array.from(s.bytes)).toEqual([0, 0, 7]);
    expect(s.undoStack[0].after).toHaveLength(1);
  });

  it("ignores out-of-range offsets and no-op writes", () => {
    const s0 = createEditState(buf(5, 6));
    expect(writeBytes(s0, -1, [1])).toBe(s0);
    expect(writeBytes(s0, 2, [1])).toBe(s0);
    expect(writeBytes(s0, 0, [5, 6])).toBe(s0);
  });

  it("counts a byte as edited only while it differs from the original", () => {
    let s = createEditState(buf(1, 2, 3));
    s = writeBytes(s, 0, [9]);
    s = writeBytes(s, 0, [8]);
    expect(s.changedCount).toBe(1);
    s = writeBytes(s, 0, [1]);
    expect(s.changedCount).toBe(0);
    expect(isDirty(s)).toBe(false);
  });

  it("undoes and redoes, keeping the count right", () => {
    let s = createEditState(buf(1, 2, 3));
    s = writeBytes(s, 0, [9]);
    s = writeBytes(s, 1, [9, 9]);
    expect(s.changedCount).toBe(3);

    s = undo(s);
    expect(Array.from(s.bytes)).toEqual([9, 2, 3]);
    expect(s.changedCount).toBe(1);
    s = undo(s);
    expect(Array.from(s.bytes)).toEqual([1, 2, 3]);
    expect(s.changedCount).toBe(0);
    expect(canUndo(s)).toBe(false);
    expect(undo(s)).toBe(s);

    s = redo(s);
    s = redo(s);
    expect(Array.from(s.bytes)).toEqual([9, 9, 9]);
    expect(s.changedCount).toBe(3);
    expect(canRedo(s)).toBe(false);
    expect(redo(s)).toBe(s);
  });

  it("drops the redo stack on a new edit", () => {
    let s = writeBytes(createEditState(buf(0, 0)), 0, [1]);
    s = undo(s);
    expect(canRedo(s)).toBe(true);
    s = writeBytes(s, 1, [2]);
    expect(canRedo(s)).toBe(false);
  });

  it("coalesces writes that share a key and a span into one step", () => {
    let s = createEditState(buf(0x00, 0x00));
    s = writeBytes(s, 0, [0xa0], { coalesce: 1 });
    s = writeBytes(s, 0, [0xab], { coalesce: 1 });
    expect(s.undoStack).toHaveLength(1);
    s = writeBytes(s, 0, [0xcd], { coalesce: 2 });
    expect(s.undoStack).toHaveLength(2);
    s = undo(s);
    expect(s.bytes[0]).toBe(0xab);
    s = undo(s);
    expect(s.bytes[0]).toBe(0x00);
  });

  it("bounds history by step count, dropping the oldest", () => {
    let s = createEditState(new Uint8Array(10), { steps: 3 });
    for (let i = 0; i < 5; i++) s = writeBytes(s, i, [1]);
    expect(s.undoStack).toHaveLength(3);
    s = undo(undo(undo(s)));
    expect(canUndo(s)).toBe(false);
    // The two oldest edits are now permanent.
    expect(Array.from(s.bytes.subarray(0, 5))).toEqual([1, 1, 0, 0, 0]);
    expect(s.changedCount).toBe(2);
  });

  it("bounds history by bytes held, but always keeps the latest step", () => {
    let s = createEditState(new Uint8Array(100), { bytes: 40 });
    s = fillRange(s, 0, 10, 1); // 20 bytes held
    s = fillRange(s, 10, 20, 2); // 40
    expect(s.undoStack).toHaveLength(2);
    s = fillRange(s, 20, 30, 3); // 60 → drop the oldest
    expect(s.undoStack).toHaveLength(2);
    s = fillRange(s, 0, 100, 4); // 200 on its own: kept alone
    expect(s.undoStack).toHaveLength(1);
  });

  it("fills a range, clamped to the buffer", () => {
    const s = fillRange(createEditState(new Uint8Array(4)), 2, 10, 0x1ff);
    expect(Array.from(s.bytes)).toEqual([0, 0, 0xff, 0xff]);
    const same = createEditState(new Uint8Array(4));
    expect(fillRange(same, 3, 3, 1)).toBe(same);
  });

  it("reverts every edit as one undoable step", () => {
    const data = buf(1, 2, 3, 4, 5);
    let s = createEditState(data);
    s = writeBytes(s, 1, [9]);
    s = writeBytes(s, 3, [9]);
    s = revert(s);
    expect(Array.from(s.bytes)).toEqual([1, 2, 3, 4, 5]);
    expect(isDirty(s)).toBe(false);
    expect(s.undoStack[s.undoStack.length - 1].offset).toBe(1);
    expect(s.undoStack[s.undoStack.length - 1].after).toHaveLength(3);
    s = undo(s);
    expect(Array.from(s.bytes)).toEqual([1, 9, 3, 9, 5]);
    expect(revert(createEditState(data)).undoStack).toHaveLength(0);
  });

  it("edits a 16 MiB buffer without touching the original", () => {
    const data = new Uint8Array(16 * 1024 * 1024).fill(0xff);
    let s = createEditState(data);
    s = writeBytes(s, data.length - 1, [0]);
    s = fillRange(s, 0, 0x100, 0);
    expect(s.changedCount).toBe(0x101);
    expect(data[data.length - 1]).toBe(0xff);
    expect(data[0]).toBe(0xff);
  });
});
