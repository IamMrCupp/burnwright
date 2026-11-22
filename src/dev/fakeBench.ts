// A stand-in for the session commands (`bench` in src/lib/engine.ts), for
// the browser preview and the tests: a flashrom, a CH341A and a KB9012 that
// exist only here. It keeps the rules the screen depends on: nothing runs
// without flashrom, a session has to be open before a backup, a live board
// is read twice, and a cancel rejects with `cancelled`.
import type {
  BenchApi,
  Diagnosis,
  EngineError,
  EngineErrorKind,
  FlashromStatus,
  ProbeInfo,
  ProgressEvent,
  SavedBackup,
  SessionInfo,
  SessionOptions,
} from "../lib/engine";
import { CH341A, KB9012 } from "../lib/engine";

export interface FakeBenchOptions {
  /** Where the installed flashrom is; `null` for a machine without one. */
  flashrom?: string | null;
  /** Other paths `setFlashromPath` accepts as a working flashrom. */
  otherFlashroms?: string[];
  /** Whether a CH341A is plugged in. */
  programmer?: boolean;
  /**
   * Whether this user may open it. `"no_udev_rule"` is a Linux machine with
   * no rule for it: flashrom finds nothing, and only the diagnosis can say
   * the programmer is there.
   */
  access?: "ok" | "no_udev_rule";
  /**
   * What's on the end of the wires: a KB9012, nothing that answers, another
   * chip, or a KB9012 on a loose wire whose two reads differ.
   */
  chip?: "kb9012" | "silent" | "other" | "flaky";
  /** The first `n` identifies find nothing, then the chip answers. */
  silentTries?: number;
  /** Milliseconds between progress steps; 0 runs straight through. */
  stepMs?: number;
  /** Progress steps per read. */
  steps?: number;
}

const SIZE = 131_072;
const FLASHROM = "/opt/homebrew/sbin/flashrom";

function fail(kind: EngineErrorKind, message: string): EngineError {
  return { kind, message, device_state: kind === "cancelled" ? "unchanged" : null };
}

export interface FakeBench extends BenchApi {
  /** Every device command that ran, in order. */
  readonly calls: string[];
  /** Plug the CH341A in or pull it out. */
  setProgrammer(present: boolean): void;
  /** Install the udev rule, or take it away. */
  setAccess(access: "ok" | "no_udev_rule"): void;
  /** Install flashrom where the search finds it, or take it away. */
  setInstalled(path: string | null): void;
}

export function createFakeBench(options: FakeBenchOptions = {}): FakeBench {
  const stepMs = options.stepMs ?? 0;
  const steps = options.steps ?? 4;
  const chip = options.chip ?? "kb9012";
  let installed = options.flashrom === undefined ? FLASHROM : options.flashrom;
  let chosen: string | null = null;
  let programmer = options.programmer ?? true;
  let access = options.access ?? "ok";
  /** flashrom can open the CH341A: it's there and it's ours to use. */
  const reachable = () => programmer && access === "ok";
  let silentTries = options.silentTries ?? 0;
  let nextSession = 1;
  let open: SessionInfo | null = null;
  let backups = 0;
  const calls: string[] = [];
  const known = new Set(options.otherFlashroms ?? []);

  function status(): FlashromStatus {
    if (chosen !== null) {
      return known.has(chosen) || chosen === installed
        ? {
            availability: { status: "ready", version: "v1.8.0" },
            path: chosen,
            source: "configured",
          }
        : {
            availability: {
              status: "missing",
              reason: `flashrom not found at ${chosen} (set by the flashrom path setting); fix or clear that setting`,
            },
            path: null,
            source: null,
          };
    }
    return installed === null
      ? {
          availability: {
            status: "missing",
            reason:
              "flashrom not found; install it (`brew install flashrom`, or your distro's flashrom package) or set BURNWRIGHT_FLASHROM to the flashrom binary",
          },
          path: null,
          source: null,
        }
      : {
          availability: { status: "ready", version: "v1.8.0" },
          path: installed,
          source: "system",
        };
  }

  function flashromPath(): string {
    const now = status();
    if (now.path === null) {
      throw fail(
        "flashrom_not_found",
        now.availability.status === "missing" ? now.availability.reason : "flashrom not found",
      );
    }
    return now.path;
  }

  const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /** One step of a run: wait, then stop here if the run was cancelled. */
  async function tick(op: string, options: SessionOptions | undefined): Promise<void> {
    if (stepMs > 0) await pause(stepMs);
    else await Promise.resolve();
    if (options?.signal?.aborted) {
      options.onProgress?.({ type: "info", message: "Cancelled: letting the EC run again" });
      throw fail("cancelled", `${op} cancelled`);
    }
  }

  function emit(options: SessionOptions | undefined, event: ProgressEvent) {
    options?.onProgress?.(event);
  }

  async function read(options: SessionOptions | undefined, path: string) {
    emit(options, {
      type: "command",
      line: `${path} -p ch341a_spi -c 'KB9012 (EDI)' -r /tmp/burnwright-flashrom/read.bin --progress`,
    });
    emit(options, { type: "stage_started", stage: "read", label: "Reading flash" });
    for (let i = 1; i <= steps; i++) {
      await tick("read", options);
      emit(options, { type: "progress", stage: "read", percent: Math.round((i * 100) / steps) });
    }
    emit(options, { type: "stage_finished", stage: "read", seconds: null });
  }

  return {
    calls,
    setProgrammer(present) {
      programmer = present;
    },
    setAccess(next) {
      access = next;
    },
    setInstalled(path) {
      installed = path;
    },
    flashromStatus: async () => status(),
    setFlashromPath: async (path) => {
      chosen = path;
      return status();
    },
    listProbes: async (options) => {
      calls.push("list_probes");
      const path = flashromPath();
      emit(options, { type: "command", line: `${path} -p ch341a_spi -c MX25L6405` });
      await tick("operation", options);
      const found: ProbeInfo[] = reachable()
        ? [{ backend: "flashrom", probe: CH341A, model: "CH341A", firmware: null }]
        : [];
      return found;
    },
    diagnoseProgrammer: async () => {
      calls.push("diagnose_spi_programmer");
      const diagnosis: Diagnosis = {
        os: access === "no_udev_rule" ? "linux" : "macos",
        programmers: [],
        probe_error: null,
      };
      if (programmer) {
        diagnosis.programmers.push({
          models: "CH341A",
          usb_id: "1a86:5512",
          location: "1-2",
          state:
            access === "no_udev_rule"
              ? {
                  kind: "udev_rules_missing",
                  node: "/dev/bus/usb/001/007",
                  appimage: true,
                  install_command:
                    "sudo tee /etc/udev/rules.d/60-burnwright-flashrom.rules >/dev/null <<'EOF'\n# CH341A\nEOF\nsudo udevadm control --reload-rules && sudo udevadm trigger --subsystem-match=usb",
                }
              : { kind: "ready", driver: null, xgpro_compatible: null },
        });
      }
      return diagnosis;
    },
    openSession: async (probe, target, options) => {
      calls.push("open_session");
      const path = flashromPath();
      emit(options, { type: "command", line: `${path} -p ch341a_spi -c 'KB9012 (EDI)' -V` });
      await tick("operation", options);
      if (!reachable()) {
        emit(options, { type: "error", message: "Couldn't open device 1a86:5512." });
        throw fail("no_programmer", "no programmer detected");
      }
      if (chip === "silent" || silentTries > 0) {
        silentTries = Math.max(0, silentTries - 1);
        emit(options, { type: "info", message: "No EEPROM/flash device found." });
        throw fail(
          "no_chip",
          "nothing answered as a KB9012 (EDI) on the CH341A; check the wiring and that the board has standby power",
        );
      }
      if (chip === "other") {
        emit(options, { type: "info", message: "No EEPROM/flash device found." });
        throw fail(
          "chip_id_mismatch",
          "chip ID mismatch: expected hwversion 0xc3, ediid 0x04, found hwversion 0xc5, ediid 0x04",
        );
      }
      emit(options, {
        type: "info",
        message: 'Found ENE flash chip "KB9012 (EDI)" (128 kB, SPI) on ch341a_spi.',
      });
      open = {
        id: nextSession++,
        backend: "flashrom",
        probe,
        chip: {
          target,
          size: SIZE,
          fingerprint: "hwversion 0xc3, ediid 0x04",
          detail: "ENE KB9012 (EDI) on a CH341A",
        },
        capabilities: {
          ops: { read: true, write: false, verify: true, erase: false, blank_check: true },
          regions: ["code"],
          auto_identify: false,
          write_verifies: true,
          erased: 0,
          in_circuit: true,
          cancel: "until_mutating",
          typical_write_secs: 1800,
        },
        backup_required: true,
      };
      return open;
    },
    backup: async (sessionId, options) => {
      calls.push("backup_session");
      if (!open || open.id !== sessionId) {
        throw fail(
          "invalid_input",
          `invalid input: session ${sessionId} isn't open; identify the chip again`,
        );
      }
      const path = flashromPath();
      emit(options, { type: "info", message: "Backup: reading the chip" });
      await read(options, path);
      emit(options, {
        type: "info",
        message: "Backup: reading the chip again to check the first read",
      });
      await read(options, path);
      if (chip === "flaky") {
        throw fail(
          "inconsistent_reads",
          "two reads of the chip differ from offset 0x1234; check the connection and try again",
        );
      }
      backups += 1;
      const sha256 = "9f2c41d07b6e5a83c1d94f60e2b7a5183d6c0f9e4a7b2c5d8e1f3a6b9c0d2e4f";
      const saved: SavedBackup = {
        path: `/Users/you/Library/Application Support/burnwright/backups/ene-KB9012__EDI_-20261121T08000${backups}Z-${sha256.slice(0, 8)}.bin`,
        sha256,
        len: SIZE,
        region: "code",
      };
      emit(options, { type: "info", message: `Backup saved to ${saved.path}` });
      return saved;
    },
    closeSession: async (sessionId) => {
      const was = open?.id === sessionId;
      if (was) open = null;
      return was;
    },
  };
}

/** The target and probe the screen opens its session on, for tests that check them. */
export const FAKE_TARGET = KB9012;
export const FAKE_PROBE = CH341A;
