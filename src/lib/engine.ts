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
// Device commands reject with an `EngineError` object. The image commands
// (loadImage, saveImage) still reject with a plain string.
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
  | "busy"
  | "cancelled"
  | "not_implemented";

/** How a device command rejects (mirrors `commands::CommandError`). */
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
