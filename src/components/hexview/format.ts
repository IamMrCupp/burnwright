// Pure formatting helpers for the hex viewer. No DOM, no React.

const HEX_TABLE: readonly string[] = Array.from({ length: 256 }, (_, b) =>
  b.toString(16).toUpperCase().padStart(2, "0"),
);

const ASCII_TABLE: readonly string[] = Array.from({ length: 256 }, (_, b) =>
  b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".",
);

/** Two-digit uppercase hex for a byte value (0–255). */
export function byteToHex(value: number): string {
  return HEX_TABLE[value & 0xff];
}

/** Printable ASCII (0x20–0x7E) as itself; everything else as ".". */
export function byteToAscii(value: number): string {
  return ASCII_TABLE[value & 0xff];
}

/** Smallest address width the viewer pads to. */
export const MIN_ADDRESS_DIGITS = 4;

/**
 * How many hex digits the address column needs so every row lines up:
 * enough for the highest address in the buffer, rounded up to an even
 * count, and never fewer than `minDigits`.
 */
export function addressDigitsFor(
  byteLength: number,
  baseAddress = 0,
  minDigits = MIN_ADDRESS_DIGITS,
): number {
  const last = baseAddress + Math.max(byteLength - 1, 0);
  const needed = Math.max(last.toString(16).length, 1);
  const even = needed + (needed % 2);
  return Math.max(even, minDigits);
}

/** Uppercase hex address, zero-padded to `digits`. */
export function formatAddress(address: number, digits: number): string {
  if (!Number.isSafeInteger(address) || address < 0) {
    throw new RangeError(`address must be a non-negative safe integer, got ${address}`);
  }
  return address.toString(16).toUpperCase().padStart(digits, "0");
}
