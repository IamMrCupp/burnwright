// Byte-buffer diff for the hex viewer. Pure: no DOM, no React.
//
// The result is a sorted list of half-open [start, end) ranges of differing
// bytes, held in two Uint32Arrays rather than one object per byte, so a
// 16 MiB diff with a handful of changes costs a few bytes of output and a
// pathological one (every other byte) stays at two flat arrays. The common
// prefix is compared four bytes at a time when both buffers are 4-aligned.
//
// "a" is the buffer being looked at (e.g. a device read or readback) and "b"
// the reference it is checked against (e.g. the file or the written image).
// Where the lengths differ, the tail of the longer buffer is one final range:
// "extra" when `a` is longer (bytes not in `b`), "missing" when `b` is longer
// (bytes `a` lacks).

export type DiffKind = "changed" | "extra" | "missing";

export interface BufferDiff {
  readonly aLength: number;
  readonly bLength: number;
  /** min(aLength, bLength): the span compared byte for byte. */
  readonly commonLength: number;
  /** Bytes in the common span that differ. */
  readonly changedBytes: number;
  /** changedBytes plus the length difference. 0 means the buffers match. */
  readonly differingBytes: number;
  /** Number of ranges, the length-mismatch tail included. */
  readonly rangeCount: number;
  /** Range starts, ascending. Ranges never overlap or touch, except that a
   *  changed range may end where the tail range begins. */
  readonly starts: Uint32Array;
  /** Range ends (exclusive), parallel to `starts`. */
  readonly ends: Uint32Array;
}

/** Diff `a` against `b`. Neither buffer is modified. */
export function diffBuffers(a: Uint8Array, b: Uint8Array): BufferDiff {
  const aLength = a.length;
  const bLength = b.length;
  const common = Math.min(aLength, bLength);
  const out = new RangeBuilder();

  if (a !== b) {
    let i = 0;
    if (a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0) {
      const words = common >>> 2;
      const wa = new Uint32Array(a.buffer, a.byteOffset, words);
      const wb = new Uint32Array(b.buffer, b.byteOffset, words);
      for (let w = 0; w < words; w++) {
        if (wa[w] !== wb[w]) {
          const base = w << 2;
          for (let k = base; k < base + 4; k++) {
            if (a[k] !== b[k]) out.add(k);
          }
        }
      }
      i = words << 2;
    }
    for (; i < common; i++) {
      if (a[i] !== b[i]) out.add(i);
    }
  }

  const changedBytes = out.bytes;
  out.flush();
  if (aLength !== bLength) out.push(common, Math.max(aLength, bLength));

  return {
    aLength,
    bLength,
    commonLength: common,
    changedBytes,
    differingBytes: changedBytes + Math.abs(aLength - bLength),
    rangeCount: out.count,
    starts: out.starts.subarray(0, out.count),
    ends: out.ends.subarray(0, out.count),
  };
}

/** Kind of the range at `ordinal` (0 ≤ ordinal < rangeCount). */
export function rangeKind(diff: BufferDiff, ordinal: number): DiffKind {
  if (diff.starts[ordinal] < diff.commonLength) return "changed";
  return diff.aLength > diff.bLength ? "extra" : "missing";
}

/**
 * Ordinal of the range holding byte `index`, or -1 if that byte matches.
 * Binary search, so it is cheap enough to call per rendered byte.
 */
export function findRange(diff: BufferDiff, index: number): number {
  const { starts, ends } = diff;
  let lo = 0;
  let hi = diff.rangeCount - 1;
  // Last range whose start is <= index.
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] <= index) {
      hit = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return hit >= 0 && index < ends[hit] ? hit : -1;
}

/** Growable pair of Uint32Arrays that merges adjacent differing bytes. */
class RangeBuilder {
  starts = new Uint32Array(64);
  ends = new Uint32Array(64);
  count = 0;
  bytes = 0;
  private openStart = -1;
  private openEnd = -1;

  /** Record that byte `i` differs. Calls must be in ascending order. */
  add(i: number): void {
    this.bytes++;
    if (i === this.openEnd) {
      this.openEnd++;
      return;
    }
    this.flush();
    this.openStart = i;
    this.openEnd = i + 1;
  }

  /** Close the open run, if any. */
  flush(): void {
    if (this.openStart < 0) return;
    this.push(this.openStart, this.openEnd);
    this.openStart = -1;
    this.openEnd = -1;
  }

  push(start: number, end: number): void {
    if (this.count === this.starts.length) {
      const grow = (old: Uint32Array) => {
        const next = new Uint32Array(old.length * 2);
        next.set(old);
        return next;
      };
      this.starts = grow(this.starts);
      this.ends = grow(this.ends);
    }
    this.starts[this.count] = start;
    this.ends[this.count] = end;
    this.count++;
  }
}
