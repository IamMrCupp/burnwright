// The sums behind the entropy strip: where its outline goes, which block a
// point on it is, and how much of the buffer is flat.

import type { InspectEntropy } from "../engine";

/** The top of the scale: 8 bits a byte, in the report's thousandths of a bit. */
export const ENTROPY_MAX = 8000;

/** A block's entropy in bits: `7943` → `"7.94"`. */
export function formatBits(millibits: number): string {
  return (millibits / 1000).toFixed(2);
}

/**
 * The strip's outline as an SVG path: one unit across for each block, and
 * `ENTROPY_MAX` units tall with zero at the bottom. Blocks at one level share
 * a line, so a megabyte of erased flash is two numbers, not a thousand.
 */
export function entropyPath(millibits: readonly number[]): string {
  if (millibits.length === 0) return "";
  let path = `M0,${ENTROPY_MAX}`;
  let level: number | null = null;
  let drawnTo = 0;
  millibits.forEach((value, block) => {
    const top = ENTROPY_MAX - Math.min(Math.max(value, 0), ENTROPY_MAX);
    if (top === level) return;
    if (block > drawnTo) path += `H${block}`;
    path += `V${top}`;
    level = top;
    drawnTo = block;
  });
  return `${path}H${millibits.length}V${ENTROPY_MAX}Z`;
}

/**
 * Which of `count` blocks is `fraction` of the way along the strip. A point
 * off either end is the block at that end.
 */
export function blockAt(fraction: number, count: number): number {
  if (!(fraction > 0)) return 0;
  return Math.min(Math.floor(fraction * count), count - 1);
}

/**
 * How many of the `len` bytes scanned sit in blocks with no entropy at all:
 * one byte value repeated, which is how erased flash reads. The last block
 * counts for the bytes it has.
 */
export function flatBytes(entropy: InspectEntropy, len: number): number {
  let flat = 0;
  entropy.millibits.forEach((value, block) => {
    if (value !== 0) return;
    const start = block * entropy.block;
    flat += Math.max(0, Math.min(entropy.block, len - start));
  });
  return flat;
}

/**
 * `part` of `whole` in words: "none", "all", or a whole percentage that
 * never rounds a little to nothing or nearly all to all.
 */
export function formatShare(part: number, whole: number): string {
  if (part <= 0 || whole <= 0) return "none";
  if (part >= whole) return "all";
  const percent = Math.round((part / whole) * 100);
  if (percent < 1) return "under 1%";
  if (percent > 99) return "over 99%";
  return `${percent}%`;
}
