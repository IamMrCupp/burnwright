import { describe, expect, it } from "vitest";
import { diffBuffers, findRange, rangeKind, type BufferDiff } from "./diff";

const bytes = (...values: number[]) => Uint8Array.from(values);

/** Fill byte i with i & 0xff. */
const ramp = (length: number) => {
  const data = new Uint8Array(length);
  for (let i = 0; i < length; i++) data[i] = i & 0xff;
  return data;
};

/** Copy of `data` with each listed byte inverted. */
const flip = (data: Uint8Array, ...indices: number[]) => {
  const out = data.slice();
  for (const i of indices) out[i] ^= 0xff;
  return out;
};

const ranges = (d: BufferDiff) =>
  Array.from({ length: d.rangeCount }, (_, i) => [d.starts[i], d.ends[i]]);

describe("diffBuffers", () => {
  it("reports no ranges for identical buffers", () => {
    const d = diffBuffers(ramp(100), ramp(100));
    expect(d.rangeCount).toBe(0);
    expect(d.changedBytes).toBe(0);
    expect(d.differingBytes).toBe(0);
    expect(d.commonLength).toBe(100);
  });

  it("reports no ranges for the same buffer passed twice", () => {
    const data = ramp(64);
    expect(diffBuffers(data, data).rangeCount).toBe(0);
  });

  it("handles two empty buffers", () => {
    const d = diffBuffers(new Uint8Array(0), new Uint8Array(0));
    expect(d.rangeCount).toBe(0);
    expect(d.differingBytes).toBe(0);
  });

  it("finds a single differing byte", () => {
    const d = diffBuffers(bytes(1, 2, 3, 4, 5), bytes(1, 2, 9, 4, 5));
    expect(ranges(d)).toEqual([[2, 3]]);
    expect(d.changedBytes).toBe(1);
    expect(rangeKind(d, 0)).toBe("changed");
  });

  it("merges adjacent differing bytes into one range", () => {
    const a = ramp(32);
    const d = diffBuffers(a, flip(a, 5, 6, 7, 8, 9));
    expect(ranges(d)).toEqual([[5, 10]]);
    expect(d.changedBytes).toBe(5);
  });

  it("keeps separated runs apart and in order", () => {
    const a = ramp(64);
    const d = diffBuffers(a, flip(a, 0, 1, 3, 40, 63));
    expect(ranges(d)).toEqual([[0, 2], [3, 4], [40, 41], [63, 64]]);
    expect(d.changedBytes).toBe(5);
  });

  it("finds a difference at every byte position within a word", () => {
    const a = ramp(16);
    for (let i = 0; i < 16; i++) {
      expect(ranges(diffBuffers(a, flip(a, i)))).toEqual([[i, i + 1]]);
    }
  });

  it("merges a run that crosses word boundaries", () => {
    const a = ramp(32);
    const d = diffBuffers(a, flip(a, 3, 4, 5, 6, 7, 8));
    expect(ranges(d)).toEqual([[3, 9]]);
  });

  it("compares a trailing partial word", () => {
    const a = ramp(19); // 4 whole words + 3 bytes
    expect(ranges(diffBuffers(a, flip(a, 17, 18)))).toEqual([[17, 19]]);
  });

  it("gives the same answer for unaligned views", () => {
    const backingA = ramp(70);
    const backingB = flip(backingA, 1, 2, 30, 31, 32, 68);
    // Offset 1 into each backing buffer: not 4-aligned.
    const a = backingA.subarray(1, 69);
    const b = backingB.subarray(1, 69);
    expect(ranges(diffBuffers(a, b))).toEqual([[0, 2], [29, 32], [67, 68]]);
    // One aligned, one not.
    const c = backingB.slice(1, 69);
    expect(ranges(diffBuffers(a, c))).toEqual([[0, 2], [29, 32], [67, 68]]);
  });

  it("marks the tail as extra when the first buffer is longer", () => {
    const d = diffBuffers(ramp(20), ramp(16));
    expect(ranges(d)).toEqual([[16, 20]]);
    expect(rangeKind(d, 0)).toBe("extra");
    expect(d.changedBytes).toBe(0);
    expect(d.differingBytes).toBe(4);
    expect(d.commonLength).toBe(16);
  });

  it("marks the tail as missing when the second buffer is longer", () => {
    const d = diffBuffers(ramp(10), ramp(24));
    expect(ranges(d)).toEqual([[10, 24]]);
    expect(rangeKind(d, 0)).toBe("missing");
    expect(d.differingBytes).toBe(14);
  });

  it("keeps a change that runs into the tail separate from it", () => {
    const a = ramp(12);
    const d = diffBuffers(flip(a, 10, 11), ramp(16));
    expect(ranges(d)).toEqual([[10, 12], [12, 16]]);
    expect(rangeKind(d, 0)).toBe("changed");
    expect(rangeKind(d, 1)).toBe("missing");
    expect(d.changedBytes).toBe(2);
    expect(d.differingBytes).toBe(6);
  });

  it("treats an empty buffer against a full one as all missing", () => {
    const d = diffBuffers(new Uint8Array(0), ramp(8));
    expect(ranges(d)).toEqual([[0, 8]]);
    expect(rangeKind(d, 0)).toBe("missing");
  });

  it("does not modify either buffer", () => {
    const a = ramp(40);
    const b = flip(a, 7, 33);
    const [copyA, copyB] = [a.slice(), b.slice()];
    diffBuffers(a, b);
    expect(a).toEqual(copyA);
    expect(b).toEqual(copyB);
  });

  it("grows its range storage for a worst-case alternating diff", () => {
    const a = new Uint8Array(1024 * 1024);
    const b = a.slice();
    for (let i = 0; i < b.length; i += 2) b[i] = 1;
    const d = diffBuffers(a, b);
    expect(d.rangeCount).toBe(512 * 1024);
    expect(d.changedBytes).toBe(512 * 1024);
    expect([d.starts[1000], d.ends[1000]]).toEqual([2000, 2001]);
  });

  it("finds a few changes in 16 MiB buffers", () => {
    const size = 16 * 1024 * 1024;
    const a = ramp(size);
    const b = flip(a, 0x10, 0x1234, 0x1235, 0x7f_fff0, size - 1);
    const d = diffBuffers(a, b);
    expect(ranges(d)).toEqual([
      [0x10, 0x11],
      [0x1234, 0x1236],
      [0x7f_fff0, 0x7f_fff1],
      [size - 1, size],
    ]);
    expect(d.changedBytes).toBe(5);
  });
});

describe("findRange", () => {
  const a = ramp(64);
  const d = diffBuffers(flip(a, 4, 5, 6, 20, 50, 51), ramp(70));
  // Ranges: [4,7) [20,21) [50,52) and the missing tail [64,70).

  it("returns the ordinal of the range holding a byte", () => {
    expect([4, 5, 6].map((i) => findRange(d, i))).toEqual([0, 0, 0]);
    expect(findRange(d, 20)).toBe(1);
    expect(findRange(d, 51)).toBe(2);
    expect(findRange(d, 64)).toBe(3);
    expect(findRange(d, 69)).toBe(3);
  });

  it("returns -1 for matching bytes, including range ends", () => {
    expect([0, 3, 7, 19, 21, 49, 52, 63, 70].map((i) => findRange(d, i))).toEqual(
      [-1, -1, -1, -1, -1, -1, -1, -1, -1],
    );
  });

  it("returns -1 when there are no ranges", () => {
    expect(findRange(diffBuffers(a, a), 0)).toBe(-1);
  });
});
