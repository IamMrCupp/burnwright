// What the device screen says about a chip: its memory, how it goes on the
// programmer, whether the connected programmer takes it, and how the buffer
// compares with it. Pure functions over `ChipInfo`.
import {
  chipAvailableOn,
  PROGRAMMERS,
  type ChipInfo,
  type ChipMemory,
  type Programmer,
} from "../engine";
import { formatByteCount, formatCount, formatSize, formatSizeWithBytes, joinList } from "./format";

/** A programmer's display name: `"t48"` → `"T48"`. */
export function programmerLabel(programmer: Programmer): string {
  return PROGRAMMERS.find((p) => p.id === programmer)?.label ?? programmer;
}

/**
 * Which chip list a programmer reads. The TL866II+, T48 and T56 share one;
 * the TL866A/CS and the T76 each have their own.
 */
export function chipListOf(programmer: Programmer): "tl866a" | "tl866ii" | "t76" {
  if (programmer === "tl866a" || programmer === "t76") return programmer;
  return "tl866ii";
}

/** A chip's memory in a few words, for a search result: `"4 MiB"`. */
export function memorySummary(info: ChipInfo): string {
  if (info.kind === "logic") return "logic IC";
  const { memory } = info;
  if (!memory) return "no memory";
  if (memory.unit === "bits") return `${formatCount(memory.size)} bits`;
  if (memory.bytes === null) return "size not given";
  return formatSize(memory.bytes);
}

/** A chip's memory in full, for the details panel. */
export function memoryDescription(memory: ChipMemory): string {
  let main: string;
  if (memory.unit === "bits") {
    main = `${formatCount(memory.size)} bits (a fuse map, not a byte image)`;
  } else if (memory.bytes === null) {
    main = "minipro doesn't give a size";
  } else if (memory.unit === "words") {
    main = `${formatCount(memory.size)} words: ${formatSizeWithBytes(memory.bytes)}`;
  } else {
    main = formatSizeWithBytes(memory.bytes);
  }
  const extra = memory.data_sizes.map((size) => formatByteCount(size));
  return extra.length > 0 ? `${main}, plus ${joinList(extra)} of data memory` : main;
}

/** How the chip goes on the programmer, or `null` when minipro didn't say. */
export function socketDescription(info: ChipInfo): string | null {
  const { socket } = info;
  if (!socket) return null;
  switch (socket.kind) {
    case "dip": {
      const pkg = info.package;
      if (!pkg || /^P?DIP/i.test(pkg)) {
        return `Straight into the ZIF socket (${socket.pins} pins).`;
      }
      return `In the ZIF socket through a plain ${pkg} to DIP adapter (${socket.pins} pins).`;
    }
    case "adapter": {
      const number = /(\d+)/.exec(socket.image)?.[1];
      const which = number ? `XGecu adapter ${number}` : "an XGecu adapter";
      return `Needs ${which} (${socket.image} in Xgpro's files; burnwright doesn't ship the picture).`;
    }
    case "icsp_only":
      return "In-circuit programming only: it doesn't go in the socket.";
    case "other":
      return socket.text;
  }
}

/**
 * Why the selected programmer may not take this chip, or `null` when it
 * does or minipro didn't say. minipro itself doesn't stop you.
 */
export function availabilityWarning(
  info: ChipInfo,
  programmer: Programmer,
): string | null {
  if (chipAvailableOn(info, programmer) !== false) return null;
  const takers = info.available_on.map(programmerLabel);
  return `minipro lists ${info.name} for the ${joinList(takers)}, not the ${programmerLabel(programmer)}. It won't stop you, but the operation may fail or misbehave.`;
}

/** How the buffer's length compares with the chip's image size. */
export type SizeCheck =
  /** Nothing to compare: no buffer, or no chip details yet. */
  | { status: "none" }
  /** A logic IC: it has no memory. */
  | { status: "no_memory" }
  /** minipro gives no byte size for this chip (a PLD or an SPI NAND part). */
  | { status: "unknown"; why: "bits" | "not_given" }
  | { status: "match"; bytes: number }
  /** The buffer is smaller than the chip. */
  | { status: "short"; buffer: number; chip: number }
  /** The buffer is bigger than the chip. */
  | { status: "long"; buffer: number; chip: number };

/** Compare a buffer of `bufferLength` bytes with `info`'s image size. */
export function checkSize(
  bufferLength: number | null,
  info: ChipInfo | null,
): SizeCheck {
  if (bufferLength === null || !info) return { status: "none" };
  if (info.kind === "logic" || !info.memory) return { status: "no_memory" };
  const chip = info.memory.bytes;
  if (chip === null) {
    return {
      status: "unknown",
      why: info.memory.unit === "bits" ? "bits" : "not_given",
    };
  }
  if (bufferLength === chip) return { status: "match", bytes: chip };
  return bufferLength < chip
    ? { status: "short", buffer: bufferLength, chip }
    : { status: "long", buffer: bufferLength, chip };
}

/** True when the buffer is known not to be the chip's size. */
export function isSizeMismatch(check: SizeCheck): boolean {
  return check.status === "short" || check.status === "long";
}

/** One line on how the buffer compares with `chip`, for the buffer panel. */
export function sizeCheckText(check: SizeCheck, chip: string): string | null {
  switch (check.status) {
    case "none":
    case "no_memory":
      return null;
    case "unknown":
      return check.why === "bits"
        ? `Size not checked: ${chip} is a PLD, and minipro counts its memory in bits, so there is no byte size to compare the buffer with.`
        : `Size not checked: minipro gives no image size for ${chip}, so there is nothing to compare the buffer with.`;
    case "match":
      return `Same size as ${chip}.`;
    case "short":
      return `${formatByteCount(check.chip - check.buffer)} smaller than ${chip}, which holds ${formatByteCount(check.chip)}.`;
    case "long":
      return `${formatByteCount(check.buffer - check.chip)} bigger than ${chip}, which holds ${formatByteCount(check.chip)}.`;
  }
}
