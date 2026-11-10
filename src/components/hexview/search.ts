// Pattern parsing and byte search for the hex editor. Pure: no DOM, no React.
//
// Search scans with the engine's native Uint8Array indexOf / lastIndexOf for
// the first byte and only then compares the rest, so a miss across 16 MiB is
// one native pass.

export type PatternMode = "hex" | "ascii";

export type ParseResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; error: string };

/**
 * Parse a hex byte pattern. Accepts "DEADBEEF", "de ad be ef", "0xDE, 0xAD"
 * and similar: whitespace, commas and 0x prefixes are ignored. An odd digit
 * count or a non-hex character is an error.
 */
export function parseHexPattern(text: string): ParseResult {
  const digits = text.replace(/0x/gi, "").replace(/[\s,]+/g, "");
  if (digits.length === 0) return { ok: false, error: "Enter some hex bytes" };
  const bad = digits.match(/[^0-9a-f]/i);
  if (bad) return { ok: false, error: `“${bad[0]}” is not a hex digit` };
  if (digits.length % 2 !== 0) {
    return { ok: false, error: "Hex needs two digits per byte" };
  }
  const bytes = new Uint8Array(digits.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
  }
  return { ok: true, bytes };
}

/**
 * Encode text as one byte per character (Latin-1). Characters above U+00FF
 * have no single-byte form and are an error.
 */
export function encodeAscii(text: string): ParseResult {
  if (text.length === 0) return { ok: false, error: "Enter some text" };
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) {
      return { ok: false, error: `“${text[i]}” is not a single-byte character` };
    }
    bytes[i] = code;
  }
  return { ok: true, bytes };
}

/** Parse `text` as a pattern in the given mode. */
export function parsePattern(text: string, mode: PatternMode): ParseResult {
  return mode === "hex" ? parseHexPattern(text) : encodeAscii(text);
}

/** Bytes as spaced uppercase hex, e.g. "DE AD BE EF". */
export function bytesToHexText(bytes: Uint8Array): string {
  const parts = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    parts[i] = bytes[i].toString(16).toUpperCase().padStart(2, "0");
  }
  return parts.join(" ");
}

/** First index ≥ `from` where `pattern` occurs, or -1. */
export function indexOfPattern(
  data: Uint8Array,
  pattern: Uint8Array,
  from = 0,
): number {
  const n = pattern.length;
  if (n === 0 || n > data.length) return -1;
  const last = data.length - n;
  const first = pattern[0];
  let i = Math.max(0, from);
  while (i <= last) {
    i = data.indexOf(first, i);
    if (i < 0 || i > last) return -1;
    if (matchesAt(data, pattern, i)) return i;
    i++;
  }
  return -1;
}

/** Last index ≤ `from` where `pattern` occurs, or -1. */
export function lastIndexOfPattern(
  data: Uint8Array,
  pattern: Uint8Array,
  from = data.length,
): number {
  const n = pattern.length;
  if (n === 0 || n > data.length) return -1;
  const first = pattern[0];
  let i = Math.min(from, data.length - n);
  while (i >= 0) {
    i = data.lastIndexOf(first, i);
    if (i < 0) return -1;
    if (matchesAt(data, pattern, i)) return i;
    i--;
  }
  return -1;
}

export interface FindResult {
  /** Where the match starts. */
  index: number;
  /** True if the search went past the end (or start) and came round. */
  wrapped: boolean;
}

/**
 * Find `pattern` searching forward from `from` (inclusive) or backward from
 * `from` (inclusive), wrapping round the buffer once. Null if absent.
 */
export function findPattern(
  data: Uint8Array,
  pattern: Uint8Array,
  from: number,
  direction: "next" | "previous",
): FindResult | null {
  if (direction === "next") {
    const hit = indexOfPattern(data, pattern, from);
    if (hit >= 0) return { index: hit, wrapped: false };
    const wrap = indexOfPattern(data, pattern, 0);
    return wrap >= 0 && wrap < from ? { index: wrap, wrapped: true } : null;
  }
  const hit = from >= 0 ? lastIndexOfPattern(data, pattern, from) : -1;
  if (hit >= 0) return { index: hit, wrapped: false };
  const wrap = lastIndexOfPattern(data, pattern);
  return wrap >= 0 && wrap > from ? { index: wrap, wrapped: true } : null;
}

/**
 * Every non-overlapping match of `pattern`, left to right. Stops after
 * `limit` matches so a pattern like "FF" in an erased chip stays cheap.
 */
export function findAll(
  data: Uint8Array,
  pattern: Uint8Array,
  limit = Infinity,
): number[] {
  const hits: number[] = [];
  let i = indexOfPattern(data, pattern, 0);
  while (i >= 0 && hits.length < limit) {
    hits.push(i);
    i = indexOfPattern(data, pattern, i + pattern.length);
  }
  return hits;
}

/**
 * Parse a go-to address: hex, with or without a 0x prefix. Returns the
 * number, or null if it is not a valid non-negative hex number.
 */
export function parseAddress(text: string): number | null {
  const digits = text.trim().replace(/^0x/i, "").replace(/[\s_]/g, "");
  if (!/^[0-9a-f]+$/i.test(digits)) return null;
  const value = parseInt(digits, 16);
  return Number.isSafeInteger(value) ? value : null;
}

function matchesAt(data: Uint8Array, pattern: Uint8Array, at: number): boolean {
  for (let j = 1; j < pattern.length; j++) {
    if (data[at + j] !== pattern[j]) return false;
  }
  return true;
}
