// Numbers and names as the device screen prints them.

const GROUPED = new Intl.NumberFormat("en-US");

/** `4194304` → `"4,194,304"`. */
export function formatCount(n: number): string {
  return GROUPED.format(n);
}

/** `1` → `"1 byte"`, `4194304` → `"4,194,304 bytes"`. */
export function formatByteCount(n: number): string {
  return `${formatCount(n)} ${n === 1 ? "byte" : "bytes"}`;
}

const UNITS: readonly [number, string][] = [
  [1024 ** 3, "GiB"],
  [1024 ** 2, "MiB"],
  [1024, "KiB"],
];

/**
 * A size in the largest binary unit that divides it exactly: `4194304` →
 * `"4 MiB"`, `512` → `"512 bytes"`. Chip sizes are powers of two, so this is
 * exact for them; anything else stays in bytes instead of being rounded.
 */
export function formatSize(bytes: number): string {
  for (const [unit, name] of UNITS) {
    if (bytes >= unit && bytes % unit === 0) {
      return `${formatCount(bytes / unit)} ${name}`;
    }
  }
  return formatByteCount(bytes);
}

/** `"4 MiB (4,194,304 bytes)"`, or just the byte count when that says it all. */
export function formatSizeWithBytes(bytes: number): string {
  const size = formatSize(bytes);
  const exact = formatByteCount(bytes);
  return size === exact ? exact : `${size} (${exact})`;
}

/** The last component of a path, for either separator. */
export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** `"3, 17"` → `"3 and 17"`, for short lists in a sentence. */
export function joinList(items: readonly (string | number)[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Upper-case the first letter: engine messages start lower-case. */
export function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const capped = trimmed[0].toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}
