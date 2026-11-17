// Drives the device screen: holds its state, calls the engine, and feeds
// the results to the reducer. It takes the engine and the file dialogs as
// arguments, so the whole flow runs in a test against a fake of each.
//
// Rules it keeps:
// - One device operation at a time; the picker, the buffer and detect wait.
// - Write and Erase never start without a confirmation that names the chip.
// - The buffer goes to minipro as it is. When it isn't the chip's size, the
//   user is told first, and the size check is only turned off on their say.
// - Cancelling a write or erase asks first: it leaves the chip half-done.
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
} from "../engine";
import { isSizeMismatch } from "./chip";
import { fileName, formatByteCount } from "./format";
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
import type { RecentStore } from "./recent";
import {
  activeProgrammer,
  bufferSizeCheck,
  hasUnsavedEdits,
  initialState,
  lookupKey,
  NO_OVERRIDES,
  OP_LABELS,
  operationAvailability,
  reducer,
  selectedInfo,
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
  | "searchChips"
  | "chipInfo"
  | "checkChip"
  | "read"
  | "write"
  | "verify"
  | "blankCheck"
  | "erase"
  | "loadImage"
  | "saveImage"
>;

/** The system's open and save panels. Each resolves to a path, or `null` when the user backs out. */
export interface FileDialogs {
  open(): Promise<string | null>;
  /** `suggested` is a file name or path to start from. */
  save(suggested: string): Promise<string | null>;
}

export interface DeviceDeps {
  engine: DeviceEngine;
  dialogs: FileDialogs;
  /** Where recent chips are kept between runs. Without one they last for the session. */
  recent?: RecentStore;
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

  /** Cancels the running operation. */
  private abort: AbortController | null = null;
  /** Chips waiting for a size lookup, and whose list they're from. */
  private pending: string[] = [];
  private pendingFor: Programmer = "t48";
  private lookupsRunning = 0;

  constructor(deps: DeviceDeps) {
    this.engine = deps.engine;
    this.dialogs = deps.dialogs;
    this.recent = deps.recent;
    this.state = initialState(deps.recent?.load() ?? []);
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
    try {
      const device = await this.engine.detect({ onProgress: this.onProgress });
      this.dispatch({ type: "detect_found", device });
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

  clearChip = (): void => {
    if (this.state.running) return;
    this.dispatch({ type: "chip_cleared" });
  };

  // --- buffer ----------------------------------------------------------

  /** Open an image file into the buffer. Asks first when that would lose edits. */
  openFile = async (): Promise<void> => {
    if (this.state.running) return;
    if (hasUnsavedEdits(this.state.buffer)) {
      this.dispatch({
        type: "confirm_opened",
        confirm: { kind: "replace_buffer", by: "file", overrides: NO_OVERRIDES },
      });
      return;
    }
    await this.pickAndLoad();
  };

  private async pickAndLoad(): Promise<void> {
    let path: string | null;
    try {
      path = await this.dialogs.open();
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
  }

  /** Save the buffer to its file, or ask where when it has none. */
  save = (): Promise<void> => this.saveTo(this.state.buffer?.path ?? null);

  /** Save the buffer to a file the user picks. */
  saveAs = (): Promise<void> => this.saveTo(null);

  private async saveTo(known: string | null): Promise<void> {
    const buffer = this.state.buffer;
    if (!buffer) return;
    let path = known;
    if (!path) {
      const chip = this.state.chip.selected?.name ?? "image";
      const suggested = buffer.path ?? `${chip.replace(/[^A-Za-z0-9._-]+/g, "_")}.bin`;
      try {
        path = await this.dialogs.save(suggested);
      } catch (err) {
        this.fileFailed(`Couldn't show the save dialog: ${errorMessage(err)}`);
        return;
      }
      if (!path) return;
    }
    const bytes = buffer.bytes;
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
  }

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
      case "read":
        if (hasUnsavedEdits(this.state.buffer)) {
          this.dispatch({
            type: "confirm_opened",
            confirm: { kind: "replace_buffer", by: "read", overrides },
          });
          return;
        }
        break;
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
      outcome = failureOutcome(op, chip, err, overrides);
      lostProgrammer = isNoProgrammer(err);
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

  clearLog = (): void => {
    this.dispatch({ type: "log_cleared" });
  };
}
