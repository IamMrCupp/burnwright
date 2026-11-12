// Typed bindings for the Tauri command surface in `src-tauri/src/commands.rs`.
//
// Device commands (detect, checkChip, read, write, verify, blankCheck, erase)
// drive the minipro CLI. Each takes optional `OperationOptions`:
//
// - `onProgress` receives every `ProgressEvent` minipro reports.
// - `signal` cancels the operation when aborted. Cancelling a write or erase
//   leaves the chip partly programmed: confirm with the user first (see
//   `mutatesDevice`), and check `deviceMayBeInconsistent(err)` afterwards.
//
// The chip commands (listChips, searchChips, chipInfo) read minipro's chip
// database. They never touch the programmer: they work with nothing plugged
// in, run while a device operation is in flight, and take a `Programmer`
// to say whose list to use. The lists are cached in the Rust side, so
// `searchChips` is safe to call on every keystroke.
//
// Device and chip commands reject with an `EngineError` object. The image
// commands (loadImage, saveImage) still reject with a plain string.
import { Channel, invoke } from "@tauri-apps/api/core";

/** Memory region of the target device (mirrors `engine::MemoryKind`). */
export type MemoryKind = "code" | "data" | "config";

/**
 * How the programmer's firmware compares with the version minipro expects
 * (mirrors `engine::FirmwareStatus`). `out_of_date` is worth acting on: reads
 * and writes may misbehave. `newer_than_expected` is informational.
 */
export type FirmwareStatus = "out_of_date" | "newer_than_expected";

/** Programmer / chip info (mirrors `engine::DeviceInfo`). */
export interface DeviceInfo {
  /** Programmer model, e.g. "TL866II+", "T48", "T56". */
  programmer: string;
  /** Firmware version string, if reported. */
  firmware: string | null;
  /** Inserted / selected chip, if known. */
  chip: string | null;
  /** `null` when the firmware is the version minipro expects, or it didn't say. */
  firmware_status: FirmwareStatus | null;
  /** The firmware version minipro expects, e.g. "01.1.32". Set only with `firmware_status`. */
  firmware_expected: string | null;
  /** minipro's own note on this model, e.g. "T48 support is not yet complete!". */
  support_warning: string | null;
}

/** Pin-contact test result (mirrors `engine::PinCheck`). */
export type PinCheck =
  | { status: "passed" }
  /** ZIF pins (1-based) that don't make contact. */
  | { status: "bad_contact"; pins: number[] }
  /** Only the TL866II+ supports the pin test. */
  | { status: "unsupported" };

/** Chip ID result (mirrors `engine::ChipId`). */
export type ChipId =
  | { status: "match"; id: string }
  | {
      status: "mismatch";
      expected: string;
      found: string;
      /** minipro's guess at the chip actually in the socket. */
      detected: string | null;
    }
  | { status: "no_chip_id" };

/** What `checkChip` found (mirrors `engine::ChipCheck`). */
export interface ChipCheck {
  device: DeviceInfo;
  /** `null` when the ID check didn't run (a failed pin test stops it). */
  chip_id: ChipId | null;
  /** `null` unless a pin test was asked for. */
  pins: PinCheck | null;
}

/**
 * A programmer model minipro keeps a chip list for (mirrors
 * `engine::Programmer`; the values are minipro's `-q` ids). `tl866a` covers
 * the TL866A and TL866CS. `t76` is answered by the T76 build the app bundles.
 * A minipro 0.7.4 you point burnwright at yourself rejects it with
 * `unsupported_programmer`.
 */
export type Programmer = "tl866a" | "tl866ii" | "t48" | "t56" | "t76";

/** Every `Programmer`, in the order a picker should show them, with its name. */
export const PROGRAMMERS: readonly { id: Programmer; label: string }[] = [
  { id: "tl866a", label: "TL866A/CS" },
  { id: "tl866ii", label: "TL866II+" },
  { id: "t48", label: "T48" },
  { id: "t56", label: "T56" },
  { id: "t76", label: "T76" },
];

/**
 * The `Programmer` for a model name `detect` reports in
 * `DeviceInfo.programmer` ("T48", "TL866II+", "TL866CS"), or `null` for a
 * model the chip commands don't know.
 */
export function programmerFromModel(model: string): Programmer | null {
  switch (model.trim().toLowerCase()) {
    case "tl866a":
    case "tl866cs":
    case "tl866a/cs":
      return "tl866a";
    case "tl866ii":
    case "tl866ii+":
      return "tl866ii";
    case "t48":
      return "t48";
    case "t56":
      return "t56";
    case "t76":
      return "t76";
    default:
      return null;
  }
}

/** One chip in a list or search result (mirrors `engine::ChipEntry`). */
export interface ChipEntry {
  /** The name to pass as `part`, e.g. "W25Q32BV@SOIC8". */
  name: string;
  /** The package after the name's `@`, e.g. "SOIC8". `null` for a bare name (usually the DIP part). */
  package: string | null;
  /** From a `<custom>` section of minipro's database, not the stock list. */
  custom: boolean;
}

/**
 * Every chip minipro lists for a programmer (mirrors `engine::ChipList`).
 *
 * The TL866II+, T48 and T56 share one list, and it isn't filtered by model:
 * check `ChipInfo.available_on` for the chip the user picks. Logic ICs
 * (testable, not programmable) are in the list too; `ChipInfo.kind` tells.
 */
export interface ChipList {
  programmer: Programmer;
  /** In database order, each name once. About 27,600 for the T48. */
  chips: ChipEntry[];
}

/** A search result (mirrors `engine::ChipSearch`). */
export interface ChipSearch {
  /** How many chips matched, which can be more than `chips` holds. */
  total: number;
  /** The best matches, best first: exact name, then names starting with the first word, then the rest. */
  chips: ChipEntry[];
}

/** Programmable part or logic IC (mirrors `engine::ChipKind`). */
export type ChipKind =
  /** Memories, microcontrollers, PLDs: something to read or write. */
  | "programmable"
  /** A logic IC minipro can only test. Nothing to read or write. */
  | "logic";

/** A chip's memory (mirrors `engine::ChipMemory`). */
export interface ChipMemory {
  /** Size of the main (code) memory, in `unit`s. */
  size: number;
  unit: "bytes" | "words" | "bits";
  /**
   * The code memory in bytes: the size of the image minipro reads and
   * expects to write. `null` for `bits` (a PLD fuse map isn't a raw image).
   */
  bytes: number | null;
  /** Extra memories in bytes, in minipro's order: data (EEPROM) first. */
  data_sizes: number[];
}

/** How the chip goes on the programmer (mirrors `engine::ChipSocket`). */
export type ChipSocket =
  /**
   * In the ZIF socket, through a plain package adapter if the part isn't
   * DIP. `pins` is minipro's count: a BGA153 eMMC reads 37.
   */
  | { kind: "dip"; pins: number }
  /** Needs one of XGecu's numbered adapters; `image` is e.g. "Adapter008.JPG". */
  | { kind: "adapter"; image: string }
  /** In-circuit programming only. */
  | { kind: "icsp_only" }
  /** Something the parser didn't recognise, as minipro printed it. */
  | { kind: "other"; text: string };

/** One chip's details (mirrors `engine::ChipInfo`). */
export interface ChipInfo {
  /** The name as the database spells it. */
  name: string;
  /** The package in the name, as in `ChipEntry.package`. */
  package: string | null;
  kind: ChipKind;
  /** The programmers that take this chip. Empty when minipro didn't say (logic ICs). */
  available_on: Programmer[];
  /** `null` for logic ICs. */
  memory: ChipMemory | null;
  socket: ChipSocket | null;
  /** Xgpro's picture of the in-circuit wiring, e.g. "ICP009.JPG". `null`: no ICSP mode. */
  icsp: string | null;
  /** minipro's protocol id. */
  protocol: number | null;
  /** Bytes per read transfer. */
  read_buffer_size: number | null;
  /** Bytes per write transfer. */
  write_buffer_size: number | null;
  /** Everything else minipro printed: voltages, pulse delay, a logic IC's vector count. */
  details: { label: string; value: string }[];
}

/**
 * Whether `programmer` takes `chip`: `null` when minipro didn't say. The
 * shared TL866II+/T48/T56 list has chips only one of them can program, and
 * minipro doesn't stop you picking one.
 */
export function chipAvailableOn(
  chip: ChipInfo,
  programmer: Programmer,
): boolean | null {
  if (chip.available_on.length === 0) return null;
  return chip.available_on.includes(programmer);
}

/** A step minipro reports progress for (mirrors `engine::Stage`). */
export type Stage =
  | "read"
  | "write"
  | "verify"
  | "blank_check"
  | "erase"
  | "protect"
  | "unprotect"
  | "firmware_update";

/** One progress event from minipro's output (mirrors `engine::ProgressEvent`). */
export type ProgressEvent =
  | { type: "stage_started"; stage: Stage; label: string }
  | { type: "progress"; stage: Stage; percent: number }
  | { type: "stage_finished"; stage: Stage; seconds: number | null }
  | { type: "info"; message: string }
  | { type: "warning"; message: string }
  | { type: "error"; message: string };

/** A device operation (mirrors `engine::Operation`). */
export type Operation =
  | "read"
  | "write"
  | "verify"
  | "blank_check"
  | "erase"
  | "other";

/** What a cancelled operation may have left on the chip. */
export type DeviceState = "unchanged" | "may_be_inconsistent";

/** Kinds of `EngineError` (mirrors `commands::CommandError`). */
export type EngineErrorKind =
  | "minipro"
  | "no_programmer"
  | "minipro_not_found"
  | "verify_failed"
  | "invalid_input"
  /** `chipInfo`: minipro has no chip by that name. */
  | "unknown_chip"
  /** minipro couldn't read `infoic.xml` / `logicic.xml`; the message has the path. */
  | "missing_database"
  /** This minipro doesn't know the `Programmer` asked for (the T76, when a minipro 0.7.4 is the one in use). */
  | "unsupported_programmer"
  | "busy"
  | "cancelled"
  | "not_implemented";

/** How a device or chip command rejects (mirrors `commands::CommandError`). */
export interface EngineError {
  kind: EngineErrorKind;
  message: string;
  /** For `cancelled`: whether the chip may be partly written or erased. */
  device_state: DeviceState | null;
}

/** Where minipro was found (mirrors `commands::MiniproLocation`). */
export interface MiniproLocation {
  path: string;
  source: "configured" | "env" | "sidecar" | "path" | "explicit";
}

/** OS a diagnosis ran on (mirrors `engine::diagnose::HostOs`). */
export type HostOs = "linux" | "windows" | "macos" | "other";

/** Why a bound Windows driver is no use (mirrors `engine::diagnose::WrongDriverReason`). */
export type WrongDriverReason = "not_winusb" | "libusbk_dll_missing";

/** What's in the way of one programmer (mirrors `engine::diagnose::ProgrammerState`). */
export type ProgrammerState =
  /** Present and usable as far as the OS can tell: something else has it open. */
  | {
      kind: "ready";
      /** Windows: the bound service, e.g. "WinUSB". */
      driver: string | null;
      /** Windows: XGecu's interface GUID is registered too, so Xgpro sees it. */
      xgpro_compatible: boolean | null;
    }
  /** The bundled minipro doesn't support this model yet (T76). */
  | { kind: "unsupported_model" }
  /**
   * macOS: a T76 linked at USB 3 speed. On Apple Silicon it never answers
   * there; it needs a USB 2.0 hub or a USB 2.0-only cable (issue #50).
   */
  | {
      kind: "usb3_link";
      /** Bits per second: 5_000_000_000 for SuperSpeed. */
      link_speed_bps: number;
      /** `false`: the bundled minipro doesn't know the T76 either. */
      model_supported: boolean;
    }
  /** Linux: no permission and no minipro udev rules. */
  | {
      kind: "udev_rules_missing";
      node: string;
      appimage: boolean;
      install_command: string;
    }
  /** Linux: the device node belongs to a group the user isn't in. */
  | { kind: "not_in_group"; node: string; group: string; command: string }
  /** Linux: rules are installed but haven't applied to this device. */
  | {
      kind: "udev_rules_not_applied";
      node: string;
      rules_files: string[];
      reload_command: string;
    }
  /** Linux: the device node is missing or won't open. */
  | { kind: "node_unavailable"; node: string; error: string }
  /** Windows: no driver bound (Code 28). */
  | { kind: "no_driver" }
  /** Windows: a driver libusb can't use. */
  | {
      kind: "wrong_driver";
      service: string;
      provider: string | null;
      reason: WrongDriverReason;
    }
  /** Windows: the device has a problem code. */
  | { kind: "device_problem"; code: number; service: string | null };

/** One programmer found on USB (mirrors `engine::diagnose::ProgrammerReport`). */
export interface ProgrammerReport {
  /** e.g. "TL866II+ / T48 / T56". */
  models: string;
  /** "vvvv:pppp", lowercase hex. */
  usb_id: string;
  /** Where it's plugged in, in the OS's terms. */
  location: string;
  state: ProgrammerState;
}

/** Why no programmer was found (mirrors `engine::diagnose::Diagnosis`). */
export interface Diagnosis {
  os: HostOs;
  /** Empty: nothing plugged in (unless `probe_error` is set or `os` is "other"). */
  programmers: ProgrammerReport[];
  /** The OS probe couldn't run, so `programmers` says nothing. */
  probe_error: string | null;
}

/** On-disk image format (mirrors `engine::ImageFormat`). */
export type ImageFormat = "bin" | "intel_hex";

/** Build/version info (mirrors `commands::AppInfo`). */
export interface AppInfo {
  /** burnwright's own version. */
  version: string;
  /** Version of the vendored minipro this build was compiled against. */
  minipro: string;
}

/** Options every device command takes. */
export interface OperationOptions {
  /** Called for every progress event, in order. */
  onProgress?: (event: ProgressEvent) => void;
  /**
   * Cancels the operation when aborted. The promise then rejects with a
   * `cancelled` EngineError. Confirm first for writes and erases.
   */
  signal?: AbortSignal;
}

/** Whether interrupting `op` can leave the chip partly modified. */
export function mutatesDevice(op: Operation): boolean {
  return op === "write" || op === "erase";
}

/** Type guard for the object device commands reject with. */
export function isEngineError(err: unknown): err is EngineError {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as EngineError).kind === "string" &&
    typeof (err as EngineError).message === "string"
  );
}

/** True when `err` means minipro found no programmer: time to `diagnoseProgrammer`. */
export function isNoProgrammer(err: unknown): boolean {
  return isEngineError(err) && err.kind === "no_programmer";
}

/** True when `err` is a cancelled write or erase: the chip may be partly programmed. */
export function deviceMayBeInconsistent(err: unknown): boolean {
  return (
    isEngineError(err) &&
    err.kind === "cancelled" &&
    err.device_state === "may_be_inconsistent"
  );
}

/** A message for any rejection: an EngineError, an Error or a string. */
export function errorMessage(err: unknown): string {
  if (isEngineError(err)) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

let fallbackCounter = 0;

function newOpId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  fallbackCounter += 1;
  return `op-${Date.now()}-${fallbackCounter}-${Math.random().toString(36).slice(2)}`;
}

/** Cancel a running device operation by id. Resolves to whether it was running. */
function cancelOperation(opId: string): Promise<boolean> {
  return invoke("cancel_operation", { opId });
}

async function deviceOp<T>(
  command: string,
  args: Record<string, unknown>,
  options: OperationOptions = {},
): Promise<T> {
  const { onProgress, signal } = options;
  const opId = newOpId();
  const channel = new Channel<ProgressEvent>();
  if (onProgress) channel.onmessage = onProgress;
  const abort = () => {
    // The backend remembers a cancel that beats its operation, so the
    // ordering of these two IPC calls doesn't matter.
    void cancelOperation(opId);
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    return await invoke<T>(command, { ...args, opId, onProgress: channel });
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

/** Bytes to send over IPC. A Uint8Array would serialize as an object. */
function toByteArray(data: ArrayLike<number>): number[] {
  return Array.isArray(data) ? data : Array.from(data);
}

export const engine = {
  /** burnwright and bundled minipro versions. */
  appInfo: (): Promise<AppInfo> => invoke("app_info"),
  /** Where minipro was found; rejects with `minipro_not_found` if nowhere. */
  miniproLocation: (): Promise<MiniproLocation> => invoke("minipro_location"),
  /**
   * Override the minipro binary for this session (`null` clears it). Beats
   * `BURNWRIGHT_MINIPRO` and `PATH`. Resolves to the new location.
   */
  setMiniproPath: (path: string | null): Promise<MiniproLocation> =>
    invoke("set_minipro_path", { path }),
  /**
   * Ask the OS why no programmer was found: which known programmers are on
   * USB, and what's in the way of each. Call it after `detect` rejects with
   * `no_programmer`. Never rejects; doesn't claim the programmer.
   */
  diagnoseProgrammer: (): Promise<Diagnosis> => invoke("diagnose_programmer"),
  /**
   * Every chip minipro lists for `programmer`: a large reply. For a picker,
   * use `searchChips`. No programmer needs to be connected.
   */
  listChips: (programmer: Programmer): Promise<ChipList> =>
    invoke("list_chips", { programmer }),
  /**
   * Search `programmer`'s chip list. Every word of `query` has to be in the
   * name, ignoring case ("w25q32 soic"). Resolves to the best `limit`
   * matches (default 50) and the total. An empty query matches everything.
   * Only the first call for a programmer runs minipro, so this is fine to
   * call as the user types.
   */
  searchChips: (
    programmer: Programmer,
    query: string,
    limit?: number,
  ): Promise<ChipSearch> =>
    invoke("search_chips", { programmer, query, limit: limit ?? null }),
  /**
   * Describe one chip: memory size, package, adapter, which programmers
   * take it. Rejects with `unknown_chip` when minipro has no such name.
   */
  chipInfo: (programmer: Programmer, name: string): Promise<ChipInfo> =>
    invoke("chip_info", { programmer, name }),
  /** Detect the connected programmer and its firmware. */
  detect: (options?: OperationOptions): Promise<DeviceInfo> =>
    deviceOp("detect", {}, options),
  /** Check the chip in the socket against `part` by ID, optionally testing pin contact. */
  checkChip: (
    part: string,
    pinCheck = false,
    options?: OperationOptions,
  ): Promise<ChipCheck> =>
    deviceOp("check_chip", { part, pinCheck }, options),
  /** Read `kind` memory from `part`. */
  read: (
    part: string,
    kind: MemoryKind,
    options?: OperationOptions,
  ): Promise<number[]> => deviceOp("read", { part, kind }, options),
  /** Write `data` to `kind` memory of `part`; minipro reads it back to verify. */
  write: (
    part: string,
    kind: MemoryKind,
    data: ArrayLike<number>,
    options?: OperationOptions,
  ): Promise<void> =>
    deviceOp("write", { part, kind, data: toByteArray(data) }, options),
  /** Verify `kind` memory of `part` against `data`; rejects with `verify_failed` on a mismatch. */
  verify: (
    part: string,
    kind: MemoryKind,
    data: ArrayLike<number>,
    options?: OperationOptions,
  ): Promise<void> =>
    deviceOp("verify", { part, kind, data: toByteArray(data) }, options),
  /** Blank-check every region of `part`: `true` if blank. */
  blankCheck: (part: string, options?: OperationOptions): Promise<boolean> =>
    deviceOp("blank_check", { part }, options),
  /** Erase `part`. */
  erase: (part: string, options?: OperationOptions): Promise<void> =>
    deviceOp("erase", { part }, options),
  /**
   * Load a `.bin` or Intel HEX file as bytes from address 0. HEX gaps are
   * filled with `fill` (default 0xFF). Parsing happens in Rust.
   */
  loadImage: (
    path: string,
    format?: ImageFormat,
    fill?: number,
  ): Promise<number[]> =>
    invoke("load_image", { path, format: format ?? null, fill: fill ?? null }),
  /** Save `data` (from address 0) as a `.bin` or Intel HEX file. */
  saveImage: (
    path: string,
    data: number[],
    format?: ImageFormat,
  ): Promise<void> =>
    invoke("save_image", { path, data, format: format ?? null }),
};
