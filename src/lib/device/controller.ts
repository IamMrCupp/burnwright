// Drives the device screen: holds its state, calls the engine, and feeds
// the results to the reducer. It takes the engine and the file dialogs as
// arguments, so the whole flow runs in a test against a fake of each.
//
// Rules it keeps:
// - One device operation at a time; the picker, the buffer and detect wait.
// - No operation starts while a file is being opened or saved, and no file
//   is opened or saved while one runs: the bytes an operation works on are
//   the ones on screen, and the ones its confirmation described.
// - Write and Erase never start without a confirmation that names the chip.
// - The buffer goes to minipro as it is. When it isn't the chip's size, the
//   user is told first, and the size check is only turned off on their say.
// - Cancelling a write or erase asks first: it leaves the chip half-done.
// - A chip read that isn't in a file, or edits that aren't, are never
//   replaced or closed away without asking.
// - The window doesn't close under a running operation: the operation is
//   stopped first, and a write or erase asks before that.
// - The T76's algorithm file is the user's own: the screen only ever holds
//   its path, and hands that to the engine.
// - A scan of the buffer touches no chip, so it runs beside an operation.
//   Its report is of the bytes it was given: a new buffer drops it, and an
//   edit marks it stale.
// - Saving part of the buffer is a file of its own: the buffer's file and
//   its unsaved mark stay as they were.
import {
  errorMessage,
  isEngineError,
  isNoProgrammer,
  mutatesDevice,
  type ChipEntry,
  type EngineApi,
  type OperationOptions,
  type Programmer,
  type ProgressEvent,
  type SpiPins,
} from "../engine";
import { isSizeMismatch } from "./chip";
import { fileName, formatByteCount, formatOffset, regionFileName } from "./format";
import {
  blankOutcome,
  checkOutcome,
  eraseOutcome,
  failureOutcome,
  plainMessage,
  readOutcome,
  verifyOutcome,
  writeOutcome,
} from "./messages";
import { pathMasker } from "../stream/mask";
import type { RecentStore } from "./recent";
import type { SettingsStore } from "./settings";
import {
  activeProgrammer,
  autoAvailability,
  autoSummary,
  bufferSizeCheck,
  initialState,
  lookupKey,
  mutatingOp,
  needsAlgorithmFile,
  NO_OVERRIDES,
  OP_LABELS,
  operationAvailability,
  reducer,
  selectedInfo,
  unsavedBuffer,
  type Action,
  type ChipRef,
  type DeviceState,
  type OpKind,
  type Outcome,
  type Overrides,
} from "./state";

/** The engine commands the screen uses. */
export type DeviceEngine = Pick<
  EngineApi,
  | "detect"
  | "diagnoseProgrammer"
  | "algorithmFile"
  | "setAlgorithmPath"
  | "searchChips"
  | "chipInfo"
  | "checkChip"
  | "detectSpi"
  | "read"
  | "write"
  | "verify"
  | "blankCheck"
  | "erase"
  | "loadImage"
  | "saveImage"
  | "inspectBuffer"
>;

/** The system's open and save panels. Each resolves to a path, or `null` when the user backs out. */
export interface FileDialogs {
  open(): Promise<string | null>;
  /**
   * `suggested` is a file name or path to start from. `what` is `"region"`
   * when it's part of the buffer being saved, which only ever goes out as
   * raw bytes.
   */
  save(suggested: string, what?: "region"): Promise<string | null>;
  /** Pick the user's own `algorithm.xml` for a T76. */
  openAlgorithms(): Promise<string | null>;
}

export interface DeviceDeps {
  engine: DeviceEngine;
  dialogs: FileDialogs;
  /** Where recent chips are kept between runs. Without one they last for the session. */
  recent?: RecentStore;
  /** Where settings are kept between runs. Without one they last for the session. */
  settings?: SettingsStore;
  /**
   * Closes the app's window for good, without asking it again. Called once
   * `requestClose` has said no and the user, or a stopped operation, has
   * cleared the way.
   */
  closeWindow?: () => void;
}

/** How many matches the picker asks for. Each one gets a size lookup. */
export const SEARCH_LIMIT = 30;

/** How many `chipInfo` requests run at once to fill in sizes. */
const LOOKUP_CONCURRENCY = 2;

export class DeviceController {
  private state: DeviceState;
  private readonly listeners = new Set<() => void>();
  private readonly engine: DeviceEngine;
  private readonly dialogs: FileDialogs;
  private readonly recent: RecentStore | undefined;
  private readonly settings: SettingsStore | undefined;
  private readonly closeWindow: () => void;
  /** Settles once the remembered algorithm file has been handed to the engine. */
  private readonly restored: Promise<void>;
  /** The remembered algorithm file the engine hasn't taken yet. */
  private unrestored: string | null = null;

  /** Cancels the running operation. */
  private abort: AbortController | null = null;
  /** Cancels the running scan of the buffer. */
  private scanAbort: AbortController | null = null;
  /** The window closes as soon as the running operation has stopped. */
  private closeWhenStopped = false;
  /** Chips waiting for a size lookup, and whose list they're from. */
  private pending: string[] = [];
  private pendingFor: Programmer = "t48";
  private lookupsRunning = 0;

  constructor(deps: DeviceDeps) {
    this.engine = deps.engine;
    this.dialogs = deps.dialogs;
    this.recent = deps.recent;
    this.settings = deps.settings;
    this.closeWindow = deps.closeWindow ?? (() => {});
    this.state = initialState(deps.recent?.load() ?? []);
    this.restored = this.restoreAlgorithmFile();
  }

  // --- store -----------------------------------------------------------

  getState = (): DeviceState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private dispatch(action: Action): void {
    const next = reducer(this.state, action);
    if (next === this.state) return;
    this.state = next;
    // A scan nobody is waiting for any more is stopped: its buffer was
    // replaced, or its panel closed.
    if (this.scanAbort && next.inspect?.status !== "scanning") {
      this.scanAbort.abort();
      this.scanAbort = null;
    }
    for (const listener of this.listeners) listener();
  }

  private readonly onProgress = (event: ProgressEvent): void => {
    this.dispatch({ type: "progress", event });
  };

  // --- programmer ------------------------------------------------------

  /** Look for a programmer; when there is none, ask the OS why. */
  detect = async (): Promise<void> => {
    if (this.state.running || this.state.programmer.status === "detecting") return;
    const before = activeProgrammer(this.state);
    this.dispatch({ type: "detect_started" });
    this.dispatch({ type: "logged", kind: "heading", text: "Detect programmer" });
    // No operation can start before a detect, so this is where the engine
    // is sure to have the remembered algorithm file, or to have been asked
    // again if it didn't take it the first time.
    await this.restored;
    if (this.unrestored !== null) await this.applyRemembered(this.unrestored);
    try {
      const device = await this.engine.detect({ onProgress: this.onProgress });
      this.dispatch({ type: "detect_found", device });
      // The file can come and go between detects; look again each time.
      if (needsAlgorithmFile(this.state)) await this.refreshAlgorithms();
    } catch (err) {
      if (isNoProgrammer(err)) {
        await this.reportNoProgrammer();
      } else {
        const message = plainMessage(err);
        this.dispatch({ type: "detect_failed", message });
        this.dispatch({ type: "logged", kind: "error", text: message });
      }
    }
    this.programmerMayHaveChanged(before);
  };

  private async reportNoProgrammer(): Promise<void> {
    this.dispatch({ type: "detect_none" });
    this.dispatch({ type: "logged", kind: "note", text: "No programmer found." });
    // diagnoseProgrammer doesn't reject; if the IPC itself fails there is
    // only the bare "no programmer" to show.
    const diagnosis = await this.engine.diagnoseProgrammer().catch(() => null);
    this.dispatch({ type: "diagnosed", diagnosis });
  }

  /** Choose whose chip list to search. Only counts while no programmer is detected. */
  chooseProgrammer = (programmer: Programmer): void => {
    if (this.state.running) return;
    const before = activeProgrammer(this.state);
    this.dispatch({ type: "programmer_chosen", programmer });
    this.programmerMayHaveChanged(before);
  };

  /** A different chip list: search it again, and look the selected chip up in it. */
  private programmerMayHaveChanged(before: Programmer): void {
    const now = activeProgrammer(this.state);
    if (now === before) return;
    this.pending = [];
    const { query, selected } = this.state.chip;
    if (query.trim() !== "") this.search(query);
    if (selected) void this.lookUp(now, selected.name, true);
  }

  // --- algorithm file --------------------------------------------------

  /** Hand the engine the algorithm file remembered from the last run. */
  private async restoreAlgorithmFile(): Promise<void> {
    const path = this.settings?.loadAlgorithmPath() ?? null;
    pathMasker.remember(path);
    if (path !== null) await this.applyRemembered(path);
  }

  /**
   * Hand the engine a remembered algorithm file. When that fails the engine
   * has no file, and a T76 operation would run without the one the user
   * chose: so it's said, in the log and in the Programmer panel, and tried
   * again at the next detect.
   */
  private async applyRemembered(path: string): Promise<void> {
    try {
      const algorithms = await this.engine.setAlgorithmPath(path);
      this.unrestored = null;
      this.dispatch({ type: "algorithms_restore", error: null });
      this.dispatch({ type: "algorithms_checked", algorithms });
    } catch (err) {
      const again = this.unrestored === path;
      this.unrestored = path;
      const error = `burnwright couldn't apply the algorithm file remembered from last time (${path}): ${plainMessage(err)}. Until it's chosen again, minipro looks for algorithm.xml in its own places.`;
      this.dispatch({ type: "algorithms_restore", error });
      // Once in the log is enough; the panel keeps saying it.
      if (!again) this.dispatch({ type: "logged", kind: "error", text: error });
    }
  }

  /** Ask the engine whether minipro will find an algorithm file. */
  private async refreshAlgorithms(): Promise<void> {
    const algorithms = await this.engine.algorithmFile().catch(() => null);
    this.dispatch({ type: "algorithms_checked", algorithms });
  }

  /**
   * Pick the user's own `algorithm.xml` for a T76. burnwright keeps the
   * path and nothing else: minipro reads the file where it is.
   */
  chooseAlgorithmFile = async (): Promise<void> => {
    if (this.state.running || this.state.fileBusy) return;
    // Like Open and Save: nothing starts, and no other panel opens, from
    // the moment this one does until the engine has the new path. An
    // operation started in between would run with the old file while the
    // screen names the new one.
    this.dispatch({ type: "file_started", what: "choosing_algorithms" });
    try {
      let path: string | null;
      try {
        path = await this.dialogs.openAlgorithms();
        pathMasker.remember(path);
      } catch (err) {
        this.dispatch({
          type: "logged",
          kind: "error",
          text: `Couldn't show the open dialog: ${errorMessage(err)}`,
        });
        return;
      }
      if (!path) return;
      if (await this.setAlgorithmFile(path)) {
        this.dispatch({
          type: "logged",
          kind: "note",
          text: `Algorithm file set to ${path}. T76 operations pass it to minipro.`,
        });
      }
    } finally {
      this.dispatch({ type: "file_finished" });
    }
  };

  /** Go back to wherever minipro looks for the file on its own. */
  clearAlgorithmFile = async (): Promise<void> => {
    if (this.state.running || this.state.fileBusy) return;
    if (await this.setAlgorithmFile(null)) {
      this.dispatch({
        type: "logged",
        kind: "note",
        text: "Algorithm file choice cleared. minipro looks for algorithm.xml in its own places.",
      });
    }
  };

  private async setAlgorithmFile(path: string | null): Promise<boolean> {
    try {
      const algorithms = await this.engine.setAlgorithmPath(path);
      this.settings?.saveAlgorithmPath(path);
      // A fresh choice replaces whatever couldn't be restored.
      this.unrestored = null;
      this.dispatch({ type: "algorithms_restore", error: null });
      this.dispatch({ type: "algorithms_checked", algorithms });
      return true;
    } catch (err) {
      this.dispatch({
        type: "logged",
        kind: "error",
        text: `Couldn't set the algorithm file: ${plainMessage(err)}`,
      });
      return false;
    }
  }

  // --- chip picker -----------------------------------------------------

  /** The search box changed: search the active programmer's list. */
  setQuery = (query: string): void => {
    this.dispatch({ type: "query_changed", query });
    this.pending = [];
    if (query.trim() !== "") this.search(query);
  };

  private search(query: string): void {
    const programmer = activeProgrammer(this.state);
    const current = () =>
      this.state.chip.query === query && activeProgrammer(this.state) === programmer;
    this.engine.searchChips(programmer, query, SEARCH_LIMIT).then(
      (result) => {
        if (!current()) return;
        this.dispatch({ type: "search_done", query, result });
        this.queueSizeLookups(programmer, result.chips);
      },
      (err) => {
        if (!current()) return;
        this.dispatch({ type: "search_failed", query, message: plainMessage(err) });
      },
    );
  }

  /** The list has no sizes: ask for each result's details, a couple at a time. */
  private queueSizeLookups(programmer: Programmer, chips: ChipEntry[]): void {
    this.pendingFor = programmer;
    this.pending = chips
      .map((chip) => chip.name)
      .filter((name) => !(lookupKey(programmer, name) in this.state.chip.lookups));
    this.pumpLookups();
  }

  private pumpLookups(): void {
    while (this.lookupsRunning < LOOKUP_CONCURRENCY && this.pending.length > 0) {
      const name = this.pending.shift() as string;
      this.lookupsRunning += 1;
      void this.lookUp(this.pendingFor, name, false).finally(() => {
        this.lookupsRunning -= 1;
        this.pumpLookups();
      });
    }
  }

  /** Ask for a chip's details, unless they're in or on their way. `retry` asks again after a failure. */
  private async lookUp(programmer: Programmer, name: string, retry: boolean): Promise<void> {
    const key = lookupKey(programmer, name);
    const existing = this.state.chip.lookups[key];
    if (existing && !(retry && existing.status === "error")) return;
    this.dispatch({ type: "lookup", key, lookup: { status: "loading" } });
    try {
      const info = await this.engine.chipInfo(programmer, name);
      this.dispatch({ type: "lookup", key, lookup: { status: "ready", info } });
    } catch (err) {
      this.dispatch({
        type: "lookup",
        key,
        lookup: {
          status: "error",
          kind: isEngineError(err) ? err.kind : "other",
          message: plainMessage(err),
        },
      });
    }
  }

  /** Pick the chip to work on. */
  selectChip = (chip: ChipRef): void => {
    if (this.state.running) return;
    const programmer = activeProgrammer(this.state);
    this.pending = [];
    this.dispatch({
      type: "chip_selected",
      chip: { name: chip.name, package: chip.package },
      programmer,
    });
    this.recent?.save(this.state.chip.recent);
    void this.lookUp(programmer, chip.name, true);
  };

  /**
   * Auto: read the ID of the 25-series SPI flash in the socket and list the
   * parts that answer with it, for the user to pick from. Touches nothing
   * but the ID.
   */
  autoDetect = async (pins: SpiPins): Promise<void> => {
    if (!autoAvailability(this.state).enabled) return;
    this.dispatch({ type: "auto_started", pins });
    this.dispatch({ type: "logged", kind: "heading", text: `Auto (${pins}-pin SPI flash)` });
    try {
      const found = await this.engine.detectSpi(pins, { onProgress: this.onProgress });
      this.dispatch({ type: "auto_done", pins, id: found.id, chips: found.chips });
      this.dispatch({ type: "logged", kind: "note", text: autoSummary(found.id, found.chips.length) });
    } catch (err) {
      const message = plainMessage(err);
      this.dispatch({ type: "auto_failed", pins, message });
      this.dispatch({ type: "logged", kind: "error", text: `Auto failed: ${message}` });
      if (
        isEngineError(err) &&
        (err.kind === "missing_algorithms" || err.kind === "unusable_algorithms")
      ) {
        await this.refreshAlgorithms();
      }
      if (isNoProgrammer(err)) await this.reportNoProgrammer();
    }
  };

  /** Put Auto's answer away without picking from it. */
  closeAuto = (): void => {
    if (this.state.chip.auto?.status === "running") return;
    this.dispatch({ type: "auto_closed" });
  };

  clearChip = (): void => {
    if (this.state.running) return;
    this.dispatch({ type: "chip_cleared" });
  };

  // --- buffer ----------------------------------------------------------

  /**
   * Open an image file into the buffer. Asks first when that would lose
   * edits, or a chip read that was never saved.
   */
  openFile = async (): Promise<void> => {
    if (this.state.running || this.state.fileBusy) return;
    const unsaved = unsavedBuffer(this.state.buffer);
    if (unsaved) {
      this.dispatch({
        type: "confirm_opened",
        confirm: { kind: "replace_buffer", by: "file", unsaved, overrides: NO_OVERRIDES },
      });
      return;
    }
    await this.pickAndLoad();
  };

  /**
   * Pick a file and load it. Operations wait from the moment the panel
   * opens until the bytes are in: a load that landed later would swap the
   * buffer under a confirmation or a running write.
   */
  private async pickAndLoad(): Promise<void> {
    if (this.state.running || this.state.fileBusy) return;
    this.dispatch({ type: "file_started", what: "opening" });
    try {
      let path: string | null;
      try {
        path = await this.dialogs.open();
        // Before anything is said about it: an open that fails names the file.
        pathMasker.remember(path);
      } catch (err) {
        this.fileFailed(`Couldn't show the open dialog: ${errorMessage(err)}`);
        return;
      }
      if (!path) return;
      try {
        const bytes = Uint8Array.from(await this.engine.loadImage(path));
        this.dispatch({ type: "buffer_loaded", bytes, source: { kind: "file", path } });
        this.dispatch({
          type: "logged",
          kind: "note",
          text: `Opened ${path}: ${formatByteCount(bytes.length)}.`,
        });
      } catch (err) {
        this.fileFailed(`Couldn't open ${fileName(path)}: ${errorMessage(err)}`);
      }
    } finally {
      this.dispatch({ type: "file_finished" });
    }
  }

  /** Save the buffer to its file, or ask where when it has none. */
  save = (): Promise<void> => this.saveTo(this.state.buffer?.path ?? null);

  /** Save the buffer to a file the user picks. */
  saveAs = (): Promise<void> => this.saveTo(null);

  /**
   * Operations wait while this runs, and it waits for them: a read that
   * finished mid-save would be labelled with the file the old bytes went to.
   */
  private async saveTo(known: string | null): Promise<void> {
    if (!this.state.buffer || this.state.running || this.state.fileBusy) return;
    this.dispatch({ type: "file_started", what: "saving" });
    try {
      let path = known;
      if (!path) {
        const chip = this.state.chip.selected?.name ?? "image";
        const suggested =
          this.state.buffer.path ?? `${chip.replace(/[^A-Za-z0-9._-]+/g, "_")}.bin`;
        try {
          path = await this.dialogs.save(suggested);
          pathMasker.remember(path);
        } catch (err) {
          this.fileFailed(`Couldn't show the save dialog: ${errorMessage(err)}`);
          return;
        }
        if (!path) return;
      }
      // The bytes as they are now: the editor stays live while the panel is up.
      const bytes = this.state.buffer?.bytes;
      if (!bytes) return;
      try {
        await this.engine.saveImage(path, Array.from(bytes));
        this.dispatch({ type: "buffer_saved", path, bytes });
        this.dispatch({
          type: "logged",
          kind: "note",
          text: `Saved ${formatByteCount(bytes.length)} to ${path}.`,
        });
      } catch (err) {
        this.fileFailed(`Couldn't save ${fileName(path)}: ${errorMessage(err)}`);
      }
    } finally {
      this.dispatch({ type: "file_finished" });
    }
  }

  /**
   * Save `size` bytes of the buffer, from `offset`, to a file the user
   * picks: something a scan found, as a file their own tools can open.
   * `kind` is what the scan called it, and only names the file. The bytes
   * go out raw whatever the file is called, and they're the ones in the
   * buffer when this is asked for. The buffer's own file isn't touched.
   */
  saveRegion = async (offset: number, size: number, kind: string): Promise<void> => {
    const buffer = this.state.buffer;
    if (!buffer || this.state.running || this.state.fileBusy) return;
    const length = buffer.bytes.length;
    const fits =
      Number.isInteger(offset) &&
      Number.isInteger(size) &&
      offset >= 0 &&
      size > 0 &&
      offset + size <= length;
    if (!fits) {
      this.fileFailed(
        `Couldn't save that region: ${formatByteCount(size)} from ${formatOffset(offset)} runs past the end of the buffer's ${formatByteCount(length)}.`,
      );
      return;
    }
    const region = buffer.bytes.slice(offset, offset + size);
    this.dispatch({ type: "file_started", what: "saving" });
    try {
      const chip = this.state.chip.selected?.name ?? "image";
      const name = regionFileName(buffer.path ?? chip, offset, kind);
      // Next to the buffer's own file, when it has one.
      const folder = buffer.path
        ? buffer.path.slice(0, buffer.path.length - fileName(buffer.path).length)
        : "";
      let path: string | null;
      try {
        path = await this.dialogs.save(`${folder}${name}`, "region");
        pathMasker.remember(path);
      } catch (err) {
        this.fileFailed(`Couldn't show the save dialog: ${errorMessage(err)}`);
        return;
      }
      if (!path) return;
      try {
        await this.engine.saveImage(path, Array.from(region), "bin");
        this.dispatch({ type: "region_saved" });
        this.dispatch({
          type: "logged",
          kind: "note",
          text: `Saved ${formatByteCount(size)} from ${formatOffset(offset)} (${kind}) to ${path}.`,
        });
      } catch (err) {
        this.fileFailed(`Couldn't save ${fileName(path)}: ${errorMessage(err)}`);
      }
    } finally {
      this.dispatch({ type: "file_finished" });
    }
  };

  private fileFailed(message: string): void {
    this.dispatch({ type: "file_failed", message });
    this.dispatch({ type: "logged", kind: "error", text: message });
  }

  /** The hex editor changed the buffer. */
  editBuffer = (bytes: Uint8Array, edited: boolean): void => {
    this.dispatch({ type: "buffer_edited", bytes, edited });
  };

  // --- operations ------------------------------------------------------

  /**
   * Ask for an operation. Read, blank check and the chip check start right
   * away; anything that needs the user's say opens a confirmation first.
   */
  run = (op: OpKind, overrides: Overrides = NO_OVERRIDES): void => {
    if (!operationAvailability(this.state, op).enabled) return;
    const chip = this.state.chip.selected?.name;
    if (!chip) return;
    switch (op) {
      case "write":
        this.dispatch({ type: "confirm_opened", confirm: { kind: "write", chip, overrides } });
        return;
      case "erase":
        this.dispatch({ type: "confirm_opened", confirm: { kind: "erase", chip, overrides } });
        return;
      case "verify":
        if (isSizeMismatch(bufferSizeCheck(this.state)) && !overrides.ignoreSize) {
          this.dispatch({
            type: "confirm_opened",
            confirm: { kind: "verify_size", chip, overrides },
          });
          return;
        }
        break;
      case "read": {
        const unsaved = unsavedBuffer(this.state.buffer);
        if (unsaved) {
          this.dispatch({
            type: "confirm_opened",
            confirm: { kind: "replace_buffer", by: "read", unsaved, overrides },
          });
          return;
        }
        break;
      }
      default:
        break;
    }
    void this.start(op, overrides);
  };

  /** Run the last operation again with the check it tripped over turned off. */
  retry = (): void => {
    const outcome = this.state.outcome;
    if (outcome?.retry) this.run(outcome.op, outcome.retry.overrides);
  };

  /** The user said yes to the open confirmation. */
  confirm = (): void => {
    const confirm = this.state.confirm;
    if (!confirm) return;
    switch (confirm.kind) {
      case "write": {
        // Going ahead with a buffer of the wrong size is the user's call,
        // and the dialog spelled out what minipro does with it.
        const overrides = isSizeMismatch(bufferSizeCheck(this.state))
          ? { ...confirm.overrides, ignoreSize: true }
          : confirm.overrides;
        void this.start("write", overrides);
        return;
      }
      case "erase":
        void this.start("erase", confirm.overrides);
        return;
      case "verify_size":
        void this.start("verify", { ...confirm.overrides, ignoreSize: true });
        return;
      case "cancel":
        this.abortNow();
        return;
      case "replace_buffer":
        this.dispatch({ type: "confirm_closed" });
        if (confirm.by === "read") void this.start("read", confirm.overrides);
        else void this.pickAndLoad();
        return;
      case "close":
        this.dispatch({ type: "confirm_closed" });
        this.stopAndClose();
        return;
    }
  };

  /** The user backed out of the open confirmation. */
  dismissConfirm = (): void => {
    this.dispatch({ type: "confirm_closed" });
  };

  /** Stop the running operation. A write or erase asks first. */
  requestCancel = (): void => {
    const running = this.state.running;
    if (!running || running.cancelling) return;
    const op = running.op === "check" ? "other" : running.op;
    if (running.phase === "main" && mutatesDevice(op)) {
      this.dispatch({
        type: "confirm_opened",
        confirm: { kind: "cancel", op: running.op as "write" | "erase", chip: running.chip },
      });
      return;
    }
    this.abortNow();
  };

  /**
   * The window was asked to close. `true` lets it; `false` keeps it open,
   * because the user is being asked first or an operation is being stopped,
   * and `closeWindow` closes it once that's settled.
   *
   * A write or erase in progress and a buffer no file has both ask. Any
   * other operation is just stopped: closing under it would leave minipro
   * running with nothing to report to.
   */
  requestClose = (): boolean => {
    // Asked again while an operation is being stopped: it isn't stopping,
    // and the user must still be able to leave.
    if (this.closeWhenStopped) return true;
    const stop = mutatingOp(this.state);
    const unsaved = unsavedBuffer(this.state.buffer);
    if (stop || unsaved) {
      this.dispatch({ type: "confirm_opened", confirm: { kind: "close", stop, unsaved } });
      return false;
    }
    if (!this.state.running) return true;
    this.stopAndClose();
    return false;
  };

  /** Close the window, after stopping whatever is running. */
  private stopAndClose(): void {
    if (!this.state.running) {
      this.closeWindow();
      return;
    }
    this.closeWhenStopped = true;
    this.abortNow();
  }

  /**
   * The operation moved on or ended while the close question was up: ask
   * what is still true, or nothing.
   */
  private refreshCloseQuestion(): void {
    if (this.state.confirm?.kind !== "close") return;
    const stop = mutatingOp(this.state);
    const unsaved = unsavedBuffer(this.state.buffer);
    if (stop || unsaved) {
      this.dispatch({ type: "confirm_opened", confirm: { kind: "close", stop, unsaved } });
    } else {
      this.dispatch({ type: "confirm_closed" });
    }
  }

  private abortNow(): void {
    if (!this.abort || !this.state.running) {
      this.dispatch({ type: "confirm_closed" });
      return;
    }
    this.dispatch({ type: "op_cancelling" });
    this.abort.abort();
  }

  private async start(op: OpKind, overrides: Overrides): Promise<void> {
    const info = selectedInfo(this.state);
    const chip = this.state.chip.selected?.name;
    if (!operationAvailability(this.state, op).enabled || !info || !chip) {
      this.dispatch({ type: "confirm_closed" });
      return;
    }
    const image = this.state.buffer?.bytes ?? new Uint8Array();
    const abort = new AbortController();
    this.abort = abort;
    this.dispatch({ type: "op_started", op, chip, heading: `${OP_LABELS[op]} ${chip}` });

    const options: OperationOptions = {
      onProgress: this.onProgress,
      signal: abort.signal,
      ignoreChipId: overrides.ignoreChipId,
      ignoreSize: overrides.ignoreSize,
    };
    let outcome: Outcome;
    let lostProgrammer = false;
    try {
      switch (op) {
        case "read": {
          const bytes = Uint8Array.from(await this.engine.read(chip, "code", options));
          this.dispatch({ type: "buffer_loaded", bytes, source: { kind: "chip", chip } });
          outcome = readOutcome(chip, bytes.length, info.memory?.bytes ?? null);
          break;
        }
        case "verify":
          await this.engine.verify(chip, "code", image, options);
          outcome = verifyOutcome(chip, overrides);
          break;
        case "blank_check":
          outcome = blankOutcome(chip, await this.engine.blankCheck(chip, options));
          break;
        case "erase":
          await this.engine.erase(chip, options);
          outcome = eraseOutcome(chip);
          break;
        case "write":
          await this.engine.write(chip, "code", image, options);
          outcome = writeOutcome(chip, image.length, overrides);
          break;
        case "check": {
          // Only the TL866II+ can test pin contact.
          const pins = activeProgrammer(this.state) === "tl866ii";
          const check = await this.engine.checkChip(chip, pins, {
            onProgress: this.onProgress,
            signal: abort.signal,
          });
          outcome = checkOutcome(chip, check);
          break;
        }
      }
    } catch (err) {
      outcome = failureOutcome(
        op,
        chip,
        err,
        overrides,
        this.state.programmer.device?.programmer ?? null,
      );
      lostProgrammer = isNoProgrammer(err);
      // The file went missing, or was never there: let the panel say so too.
      if (
        isEngineError(err) &&
        (err.kind === "missing_algorithms" || err.kind === "unusable_algorithms")
      ) {
        await this.refreshAlgorithms();
      }
      if (
        (op === "verify" || op === "write") &&
        isEngineError(err) &&
        err.kind === "verify_failed"
      ) {
        outcome = await this.readBack(op, chip, outcome, options);
      }
    }
    this.abort = null;
    this.dispatch({
      type: "logged",
      kind: outcome.tone === "ok" ? "note" : outcome.tone,
      text:
        outcome.details.length > 0
          ? `${outcome.title}: ${outcome.details.join(" ")}`
          : outcome.title,
    });
    this.dispatch({ type: "op_finished", outcome });
    if (this.closeWhenStopped) {
      this.closeWhenStopped = false;
      this.closeWindow();
      return;
    }
    this.refreshCloseQuestion();
    if (lostProgrammer) await this.reportNoProgrammer();
  }

  /**
   * The chip doesn't match the buffer: read it again, so the screen can
   * show where. A read changes nothing on the chip.
   */
  private async readBack(
    op: "verify" | "write",
    chip: string,
    outcome: Outcome,
    options: OperationOptions,
  ): Promise<Outcome> {
    this.dispatch({ type: "op_readback" });
    this.refreshCloseQuestion();
    this.dispatch({
      type: "logged",
      kind: "note",
      text: "Reading the chip back to show where it differs from the buffer.",
    });
    try {
      const read = Uint8Array.from(
        await this.engine.read(chip, "code", {
          onProgress: options.onProgress,
          signal: options.signal,
          ignoreChipId: options.ignoreChipId,
        }),
      );
      this.dispatch({ type: "diff_opened", diff: { chip, read, after: op } });
      return {
        ...outcome,
        details: [...outcome.details, "The differences are shown under the buffer."],
      };
    } catch (err) {
      const why =
        isEngineError(err) && err.kind === "cancelled"
          ? "The read-back was cancelled, so the differences aren't shown."
          : `burnwright couldn't read the chip back to show the differences: ${plainMessage(err)}`;
      return { ...outcome, details: [...outcome.details, why] };
    }
  }

  // --- diff and log ----------------------------------------------------

  closeDiff = (): void => {
    this.dispatch({ type: "diff_closed" });
  };

  // --- what's inside the buffer ------------------------------------------

  /**
   * Scan the buffer for known formats. One scan at a time; it runs beside a
   * device operation, since it touches no chip.
   */
  inspect = async (): Promise<void> => {
    const buffer = this.state.buffer;
    if (!buffer || this.state.inspect?.status === "scanning") return;
    const scanned = buffer.bytes;
    const abort = new AbortController();
    this.scanAbort = abort;
    this.dispatch({ type: "inspect_started", bytes: scanned.length });
    try {
      const report = await this.engine.inspectBuffer(scanned, { signal: abort.signal });
      // Dropped while it ran: a new buffer came in, or the panel was closed.
      if (this.scanAbort !== abort) return;
      this.dispatch({
        type: "inspect_done",
        report,
        // Edited while it ran: the report is of the bytes as they were.
        stale: this.state.buffer?.bytes !== scanned,
      });
    } catch (err) {
      if (this.scanAbort !== abort) return;
      if (isEngineError(err) && err.kind === "cancelled") {
        this.dispatch({ type: "inspect_cancelled" });
      } else {
        this.dispatch({ type: "inspect_failed", message: errorMessage(err) });
      }
    }
  };

  /** Stop the running scan. Its panel then says it was cancelled. */
  cancelInspect = (): void => {
    this.scanAbort?.abort();
  };

  /** Put the report away, stopping the scan if one is running. */
  closeInspect = (): void => {
    this.dispatch({ type: "inspect_closed" });
  };

  clearLog = (): void => {
    this.dispatch({ type: "log_cleared" });
  };
}
