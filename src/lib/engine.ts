// Phase 0 scaffold — the frozen Tauri command contract (issue #4).
//
// These bindings call the stubbed Rust commands in `src-tauri/src/commands.rs`,
// which return a "not implemented" error until issue #6 wires them to the
// minipro engine. The signatures here mirror the Rust command signatures and
// are the agreed interface the engine/, hexview/, and frontend tracks develop
// against.
import { invoke } from "@tauri-apps/api/core";

/** Memory region of the target device (mirrors `engine::MemoryKind`). */
export type MemoryKind = "code" | "data" | "config";

/** Programmer / chip info (mirrors `engine::DeviceInfo`). */
export interface DeviceInfo {
  /** Programmer model, e.g. "TL866II+", "T48", "T56". */
  programmer: string;
  /** Firmware version string, if reported. */
  firmware: string | null;
  /** Inserted / selected chip, if known. */
  chip: string | null;
}

/** Build/version info (mirrors `commands::AppInfo`). */
export interface AppInfo {
  /** burnwright's own version. */
  version: string;
  /** Version of the vendored minipro this build was compiled against. */
  minipro: string;
}

export const engine = {
  /** burnwright and bundled minipro versions. */
  appInfo: (): Promise<AppInfo> => invoke("app_info"),
  /** Detect the connected programmer. */
  detect: (): Promise<DeviceInfo> => invoke("detect"),
  /** Read `kind` memory from `part`. */
  read: (part: string, kind: MemoryKind): Promise<number[]> =>
    invoke("read", { part, kind }),
  /** Write `data` to `kind` memory of `part`. */
  write: (part: string, kind: MemoryKind, data: number[]): Promise<void> =>
    invoke("write", { part, kind, data }),
  /** Verify `kind` memory of `part` against `data`. */
  verify: (part: string, kind: MemoryKind, data: number[]): Promise<void> =>
    invoke("verify", { part, kind, data }),
  /** Blank-check `part`. */
  blankCheck: (part: string): Promise<boolean> =>
    invoke("blank_check", { part }),
  /** Erase `part`. */
  erase: (part: string): Promise<void> => invoke("erase", { part }),
};
