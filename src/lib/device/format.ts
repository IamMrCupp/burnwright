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

/** An offset into the buffer: `4096` → `"0x00001000"`. */
export function formatOffset(offset: number): string {
  return `0x${offset.toString(16).toUpperCase().padStart(8, "0")}`;
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

/**
 * A name for a file holding part of an image: `"firmware.bin"`, `0x180000`
 * and `"squashfs"` → `"firmware-0x180000-squashfs.bin"`. Always `.bin`: what
 * goes in it is the raw bytes. `from` is the image's file name or the
 * chip's; anything a file name can't hold becomes `_`.
 */
export function regionFileName(from: string, offset: number, kind: string): string {
  // No leading dot either: that's a hidden file on two of three systems.
  const clean = (text: string) =>
    text.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+|_+$/g, "");
  const name = fileName(from);
  const dot = name.lastIndexOf(".");
  const stem = clean(dot > 0 ? name.slice(0, dot) : name) || "image";
  const what = clean(kind) || "region";
  return `${stem}-0x${offset.toString(16).toUpperCase()}-${what}.bin`;
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
