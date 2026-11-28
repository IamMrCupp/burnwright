// The device screen's state and its reducer. Everything here is pure: the
// controller (`controller.ts`) talks to the engine and dispatches the
// results, and the components render what the selectors return.
import {
  programmerFromModel,
  type AlgorithmFile,
  type ChipEntry,
  type ChipInfo,
  type ChipSearch,
  type DeviceInfo,
  type Diagnosis,
  type EngineErrorKind,
  type InspectReport,
  type Programmer,
  type ProgressEvent,
  type SpiPins,
} from "../engine";
import { checkSize, chipListOf, type SizeCheck } from "./chip";

/** What the screen can do to a chip. `check` is the ID and pin-contact test. */
export type OpKind = "read" | "verify" | "blank_check" | "erase" | "write" | "check";

/** The name each operation goes by in buttons, headings and messages. */
export const OP_LABELS: Record<OpKind, string> = {
  read: "Read",
  verify: "Verify",
  blank_check: "Blank check",
  erase: "Erase",
  write: "Write",
  check: "Check chip",
};

/** minipro's checks the user has turned off for one run. */
export interface Overrides {
  ignoreChipId: boolean;
  ignoreSize: boolean;
}

export const NO_OVERRIDES: Overrides = { ignoreChipId: false, ignoreSize: false };

/** A chip by name, as the picker and the recent list hold it. */
export interface ChipRef {
  name: string;
  package: string | null;
}

/** A chip the user picked before, and the programmer whose list it came from. */
export interface RecentChip extends ChipRef {
  programmer: Programmer;
}

/** How many recent chips are kept. */
export const RECENT_LIMIT = 8;

/** Where a `chipInfo` request stands. */
export type ChipLookup =
  | { status: "loading" }
  | { status: "ready"; info: ChipInfo }
  /** `kind` is the engine's, or `other` for a failure that wasn't an EngineError. */
  | { status: "error"; kind: EngineErrorKind | "other"; message: string };

export type ProgrammerStatus =
  /** No detect has run yet. */
  | "unknown"
  | "detecting"
  | "found"
  /** minipro found no programmer. */
  | "none"
  /** Detect failed for another reason. */
  | "error";

export interface ProgrammerState {
  status: ProgrammerStatus;
  /** The programmer, when `status` is `found`. */
  device: DeviceInfo | null;
  /** Why there's no programmer, once the OS has been asked. */
  diagnosis: Diagnosis | null;
  /** The OS is being asked why. */
  diagnosing: boolean;
  /** Why detect failed, when `status` is `error`. */
  error: string | null;
  /**
   * The model whose chip list is searched while no programmer is detected
   * (or the detected one has no list of its own): the last one detected,
   * or the one the user chose.
   */
  manual: Programmer;
}

export interface SearchState {
  status: "idle" | "loading" | "ready" | "error";
  /** The query these results answer. */
  query: string;
  results: ChipEntry[];
  /** How many chips matched, which can be more than `results` holds. */
  total: number;
  error: string | null;
}

/** Auto: the ID a 25-series SPI flash answered with, and the parts that answer with it. */
export type AutoDetectState =
  | { status: "running"; pins: SpiPins }
  | { status: "done"; pins: SpiPins; id: string | null; chips: ChipEntry[] }
  | { status: "failed"; pins: SpiPins; message: string };

/** IDs a socket reads back when nothing answers: no chip, the wrong way round, or a bad contact. */
export const NO_ANSWER_IDS: readonly string[] = ["0xFFFFFF", "0x000000"];

/** What Auto found, in a sentence: for the log, and over the list in the Chip panel. */
export function autoSummary(id: string | null, count: number): string {
  if (id === null) return "minipro didn't say what ID the chip answered with.";
  if (NO_ANSWER_IDS.includes(id)) {
    return `Nothing answered: the ID reads ${id}. Check the chip is in the socket or adapter the right way round, and that it's a 25-series SPI flash.`;
  }
  if (count === 0) {
    return `The chip answers ${id}, and nothing in minipro's list does. Look it up by the marking on the chip instead.`;
  }
  if (count === 1) return `The chip answers ${id}. One part in minipro's list does.`;
  return `The chip answers ${id}. ${count} parts in minipro's list do: pick the one marked on the chip.`;
}

export interface ChipState {
  /** What's typed in the search box. */
  query: string;
  search: SearchState;
  selected: ChipRef | null;
  /** The last Auto, until a part is picked from it or it's closed. */
  auto: AutoDetectState | null;
  /** Every `chipInfo` answer so far, by `lookupKey`. */
  lookups: Record<string, ChipLookup>;
  recent: RecentChip[];
}

/** Where the buffer's bytes came from. */
export type BufferSource =
  | { kind: "file"; path: string }
  | { kind: "chip"; chip: string };

export interface BufferState {
  /** The bytes as loaded or read: what the hex editor is given. */
  original: Uint8Array;
  /** The bytes with the user's edits: what is written, verified and saved. */
  bytes: Uint8Array;
  /** Whether `bytes` differs from `original`. */
  edited: boolean;
  /** `bytes` as of the last load, read or save. */
  saved: Uint8Array;
  source: BufferSource;
  /** The file Save writes to: the one opened or last saved. */
  path: string | null;
}

export interface RunningOp {
  op: OpKind;
  chip: string;
  /**
   * `readback`: the operation failed verification and the chip is being
   * read again to show the differences.
   */
  phase: "main" | "readback";
  /** minipro's name for the current stage, e.g. "Writing Code". */
  stage: string | null;
  /** 0 to 100, or `null` when minipro hasn't said. */
  percent: number | null;
  /** A cancel has been sent and the operation hasn't stopped yet. */
  cancelling: boolean;
}

/** How the last operation ended, as the screen words it. */
export interface Outcome {
  op: OpKind;
  chip: string;
  tone: "ok" | "warning" | "error";
  title: string;
  /** Paragraphs under the title. */
  details: string[];
  /** A check of minipro's the user can turn off to run the operation again. */
  retry: { label: string; overrides: Overrides } | null;
}

/** A question the user has to answer before something happens. */
export type Confirm =
  | { kind: "write"; chip: string; overrides: Overrides }
  | { kind: "erase"; chip: string; overrides: Overrides }
  /** Verify, with a buffer that isn't the chip's size. */
  | { kind: "verify_size"; chip: string; overrides: Overrides }
  /** Stop a running write or erase. */
  | { kind: "cancel"; op: "write" | "erase"; chip: string }
  /** Replace a buffer that holds something no file has. */
  | { kind: "replace_buffer"; by: "read" | "file"; unsaved: Unsaved; overrides: Overrides }
  /**
   * Close the window. `stop` is the write or erase that closing would cut
   * short; `unsaved` is what the buffer would lose. At least one is set.
   */
  | {
      kind: "close";
      stop: { op: "write" | "erase"; chip: string } | null;
      unsaved: Unsaved | null;
    };

/**
 * What the buffer holds that isn't in any file: a chip read that was never
 * saved, or edits made since the last load or save.
 */
export type Unsaved = "read" | "edits";

/** The chip's contents, read back after a failed verify, to diff against the buffer. */
export interface DiffState {
  chip: string;
  /** What the chip holds. */
  read: Uint8Array;
  /** What failed: a verify, or the verify at the end of a write. */
  after: "verify" | "write";
}

/**
 * A scan of the buffer for known formats, and what came of it. `null` in the
 * state means nobody has asked for one, or the panel was closed.
 */
export type InspectState =
  /** The scan is running on `bytes` bytes. */
  | { status: "scanning"; bytes: number }
  /**
   * The report. `stale` once the buffer has been edited since: an offset
   * may no longer hold what its row says.
   */
  | { status: "done"; report: InspectReport; stale: boolean }
  /** The user stopped it. */
  | { status: "cancelled" }
  /** The scan gave no report. Not the same as a report with nothing in it. */
  | { status: "failed"; message: string };

export type LogKind =
  /** The start of an operation. */
  | "heading"
  /** A minipro command line. */
  | "command"
  /** A line minipro printed. */
  | "output"
  | "warning"
  | "error"
  /** A line of burnwright's own. */
  | "note";

export interface LogLine {
  id: number;
  kind: LogKind;
  text: string;
}

/** Which file panel is up, or which file work is under way. */
export type FileBusy = "opening" | "saving" | "choosing_algorithms";

/** How many log lines are kept; the oldest go first. */
export const LOG_LIMIT = 2000;

export interface DeviceState {
  programmer: ProgrammerState;
  /**
   * Where the T76's `algorithm.xml` stands, once the engine has been asked.
   * Only a T76 needs it; see `needsAlgorithmFile`.
   */
  algorithms: AlgorithmFile | null;
  /**
   * Why the algorithm file remembered from the last run couldn't be handed
   * to the engine, when it couldn't. Until that works, operations run
   * without it.
   */
  algorithmsRestoreError: string | null;
  chip: ChipState;
  buffer: BufferState | null;
  /** Why the last open or save failed. */
  fileError: string | null;
  /**
   * A file is being picked and opened, the buffer is being saved, or the
   * T76's algorithm file is being picked. Until it's done no operation
   * starts and no other file panel opens: the buffer an operation works on,
   * and the one its confirmation described, must be the one on screen, and
   * an operation must run with the algorithm file the screen names.
   */
  fileBusy: FileBusy | null;
  running: RunningOp | null;
  outcome: Outcome | null;
  confirm: Confirm | null;
  diff: DiffState | null;
  inspect: InspectState | null;
  log: LogLine[];
  nextLogId: number;
}

const IDLE_SEARCH: SearchState = {
  status: "idle",
  query: "",
  results: [],
  total: 0,
  error: null,
};

export function initialState(recent: RecentChip[] = []): DeviceState {
  return {
    programmer: {
      status: "unknown",
      device: null,
      diagnosis: null,
      diagnosing: false,
      error: null,
      manual: "t48",
    },
    algorithms: null,
    algorithmsRestoreError: null,
    chip: {
      query: "",
      search: IDLE_SEARCH,
      selected: null,
      auto: null,
      lookups: {},
      recent,
    },
    buffer: null,
    fileError: null,
    fileBusy: null,
    running: null,
    outcome: null,
    confirm: null,
    diff: null,
    inspect: null,
    log: [],
    nextLogId: 1,
  };
}

export type Action =
  | { type: "detect_started" }
  | { type: "detect_found"; device: DeviceInfo }
  | { type: "detect_none" }
  | { type: "diagnosed"; diagnosis: Diagnosis | null }
  | { type: "detect_failed"; message: string }
  | { type: "programmer_chosen"; programmer: Programmer }
  | { type: "algorithms_checked"; algorithms: AlgorithmFile | null }
  | { type: "algorithms_restore"; error: string | null }
  | { type: "query_changed"; query: string }
  | { type: "search_done"; query: string; result: ChipSearch }
  | { type: "search_failed"; query: string; message: string }
  | { type: "lookup"; key: string; lookup: ChipLookup }
  | { type: "chip_selected"; chip: ChipRef; programmer: Programmer }
  | { type: "chip_cleared" }
  | { type: "auto_started"; pins: SpiPins }
  | { type: "auto_done"; pins: SpiPins; id: string | null; chips: ChipEntry[] }
  | { type: "auto_failed"; pins: SpiPins; message: string }
  | { type: "auto_closed" }
  | { type: "buffer_loaded"; bytes: Uint8Array; source: BufferSource }
  | { type: "buffer_edited"; bytes: Uint8Array; edited: boolean }
  | { type: "buffer_saved"; path: string; bytes: Uint8Array }
  /** Part of the buffer went to a file of its own. The buffer's file is as it was. */
  | { type: "region_saved" }
  | { type: "file_failed"; message: string }
  | { type: "file_started"; what: FileBusy }
  | { type: "file_finished" }
  | { type: "confirm_opened"; confirm: Confirm }
  | { type: "confirm_closed" }
  | { type: "op_started"; op: OpKind; chip: string; heading: string }
  | { type: "op_readback" }
  | { type: "op_cancelling" }
  | { type: "op_finished"; outcome: Outcome }
  | { type: "progress"; event: ProgressEvent }
  | { type: "diff_opened"; diff: DiffState }
  | { type: "diff_closed" }
  | { type: "inspect_started"; bytes: number }
  | { type: "inspect_done"; report: InspectReport; stale: boolean }
  | { type: "inspect_cancelled" }
  | { type: "inspect_failed"; message: string }
  | { type: "inspect_closed" }
  | { type: "logged"; kind: LogKind; text: string }
  | { type: "log_cleared" };

export function reducer(state: DeviceState, action: Action): DeviceState {
  switch (action.type) {
    case "detect_started":
      return {
        ...state,
        programmer: {
          ...state.programmer,
          status: "detecting",
          device: null,
          diagnosis: null,
          diagnosing: false,
          error: null,
        },
      };
    case "detect_found":
      return withProgrammer(state, {
        ...state.programmer,
        status: "found",
        device: action.device,
        // Keep the picker on this model's list if the programmer goes away.
        manual: programmerFromModel(action.device.programmer) ?? state.programmer.manual,
      });
    case "detect_none":
      return withProgrammer(state, {
        ...state.programmer,
        status: "none",
        device: null,
        diagnosis: null,
        diagnosing: true,
        error: null,
      });
    case "diagnosed":
      return {
        ...state,
        programmer: {
          ...state.programmer,
          diagnosis: action.diagnosis,
          diagnosing: false,
        },
      };
    case "detect_failed":
      return withProgrammer(state, {
        ...state.programmer,
        status: "error",
        device: null,
        error: action.message,
      });
    case "programmer_chosen":
      return withProgrammer(state, {
        ...state.programmer,
        manual: action.programmer,
      });

    case "algorithms_checked":
      return { ...state, algorithms: action.algorithms };
    case "algorithms_restore":
      if (state.algorithmsRestoreError === action.error) return state;
      return { ...state, algorithmsRestoreError: action.error };

    case "query_changed": {
      const query = action.query;
      const search: SearchState =
        query.trim() === ""
          ? IDLE_SEARCH
          : { ...state.chip.search, status: "loading", error: null };
      return { ...state, chip: { ...state.chip, query, search } };
    }
    case "search_done":
      // An answer to a query that has since changed is no use.
      if (action.query !== state.chip.query) return state;
      return {
        ...state,
        chip: {
          ...state.chip,
          search: {
            status: "ready",
            query: action.query,
            results: action.result.chips,
            total: action.result.total,
            error: null,
          },
        },
      };
    case "search_failed":
      if (action.query !== state.chip.query) return state;
      return {
        ...state,
        chip: {
          ...state.chip,
          search: {
            status: "error",
            query: action.query,
            results: [],
            total: 0,
            error: action.message,
          },
        },
      };
    case "lookup":
      return {
        ...state,
        chip: {
          ...state.chip,
          lookups: { ...state.chip.lookups, [action.key]: action.lookup },
        },
      };
    case "chip_selected": {
      const { chip, programmer } = action;
      const recent = [
        { ...chip, programmer },
        ...state.chip.recent.filter(
          (r) =>
            r.name !== chip.name ||
            chipListOf(r.programmer) !== chipListOf(programmer),
        ),
      ].slice(0, RECENT_LIMIT);
      return {
        ...state,
        chip: {
          ...state.chip,
          query: "",
          search: IDLE_SEARCH,
          selected: chip,
          // A part picked from Auto's list, or any other way, settles it.
          auto: null,
          recent,
        },
        // Both were about the chip that was selected before.
        outcome: null,
        diff: null,
      };
    }
    case "auto_started":
      return { ...state, chip: { ...state.chip, auto: { status: "running", pins: action.pins } } };
    case "auto_done":
      return {
        ...state,
        chip: {
          ...state.chip,
          auto: { status: "done", pins: action.pins, id: action.id, chips: action.chips },
        },
      };
    case "auto_failed":
      return {
        ...state,
        chip: {
          ...state.chip,
          auto: { status: "failed", pins: action.pins, message: action.message },
        },
      };
    case "auto_closed":
      return state.chip.auto === null ? state : { ...state, chip: { ...state.chip, auto: null } };
    case "chip_cleared":
      return {
        ...state,
        chip: { ...state.chip, selected: null },
        outcome: null,
        diff: null,
      };

    case "buffer_loaded":
      return {
        ...state,
        buffer: {
          original: action.bytes,
          bytes: action.bytes,
          edited: false,
          saved: action.bytes,
          source: action.source,
          path: action.source.kind === "file" ? action.source.path : null,
        },
        fileError: null,
        diff: null,
        // A scan was of the bytes this replaces.
        inspect: null,
        // The last outcome, and any retry it offers, was about other bytes.
        outcome: null,
      };
    case "buffer_edited":
      if (!state.buffer) return state;
      // The editor also reports the bytes it was just given.
      if (state.buffer.bytes === action.bytes && state.buffer.edited === action.edited) {
        return state;
      }
      return {
        ...state,
        buffer: { ...state.buffer, bytes: action.bytes, edited: action.edited },
        // A report is of the bytes as they were. It stays up, marked: its
        // offsets are still where to look, they just aren't promises now.
        inspect:
          state.inspect?.status === "done" && state.buffer.bytes !== action.bytes
            ? { ...state.inspect, stale: true }
            : state.inspect,
        outcome: null,
      };
    case "buffer_saved":
      if (!state.buffer) return state;
      return {
        ...state,
        // `action.bytes` is what went to the file: the buffer may have been
        // edited since.
        buffer: { ...state.buffer, saved: action.bytes, path: action.path },
        fileError: null,
      };
    case "region_saved":
      return state.fileError === null ? state : { ...state, fileError: null };
    case "file_failed":
      return { ...state, fileError: action.message };
    case "file_started":
      return { ...state, fileBusy: action.what };
    case "file_finished":
      return { ...state, fileBusy: null };

    case "confirm_opened":
      return { ...state, confirm: action.confirm };
    case "confirm_closed":
      return { ...state, confirm: null };

    case "op_started":
      return appendLog(
        {
          ...state,
          running: {
            op: action.op,
            chip: action.chip,
            phase: "main",
            stage: null,
            percent: null,
            cancelling: false,
          },
          outcome: null,
          confirm: null,
          diff: null,
        },
        "heading",
        action.heading,
      );
    case "op_readback":
      if (!state.running) return state;
      return {
        ...state,
        running: { ...state.running, phase: "readback", stage: null, percent: null },
      };
    case "op_cancelling":
      if (!state.running) return state;
      return {
        ...state,
        running: { ...state.running, cancelling: true },
        confirm: state.confirm?.kind === "cancel" ? null : state.confirm,
      };
    case "op_finished":
      return {
        ...state,
        running: null,
        outcome: action.outcome,
        // Nothing left to stop.
        confirm: state.confirm?.kind === "cancel" ? null : state.confirm,
      };
    case "progress":
      return applyProgress(state, action.event);

    case "diff_opened":
      return { ...state, diff: action.diff };
    case "diff_closed":
      return { ...state, diff: null };

    case "inspect_started":
      return { ...state, inspect: { status: "scanning", bytes: action.bytes } };
    case "inspect_done":
      return {
        ...state,
        inspect: { status: "done", report: action.report, stale: action.stale },
      };
    case "inspect_cancelled":
      return { ...state, inspect: { status: "cancelled" } };
    case "inspect_failed":
      return { ...state, inspect: { status: "failed", message: action.message } };
    case "inspect_closed":
      return state.inspect === null ? state : { ...state, inspect: null };

    case "logged":
      return appendLog(state, action.kind, action.text);
    case "log_cleared":
      return { ...state, log: [] };
  }
}

/** Swap the programmer state; a change of chip list drops the search results. */
function withProgrammer(state: DeviceState, programmer: ProgrammerState): DeviceState {
  const next = { ...state, programmer };
  if (activeProgrammer(next) === activeProgrammer(state)) return next;
  return {
    ...next,
    chip: {
      ...next.chip,
      search:
        next.chip.query.trim() === ""
          ? IDLE_SEARCH
          : { ...IDLE_SEARCH, status: "loading" },
    },
  };
}

function appendLog(state: DeviceState, kind: LogKind, text: string): DeviceState {
  const line: LogLine = { id: state.nextLogId, kind, text };
  const log =
    state.log.length >= LOG_LIMIT
      ? [...state.log.slice(state.log.length - LOG_LIMIT + 1), line]
      : [...state.log, line];
  return { ...state, log, nextLogId: state.nextLogId + 1 };
}

function applyProgress(state: DeviceState, event: ProgressEvent): DeviceState {
  const running = state.running;
  switch (event.type) {
    case "command":
      return appendLog(state, "command", event.line);
    case "info":
      return appendLog(state, "output", event.message);
    case "warning":
      return appendLog(state, "warning", event.message);
    case "error":
      return appendLog(state, "error", event.message);
    case "stage_started":
      return appendLog(
        running
          ? { ...state, running: { ...running, stage: event.label, percent: null } }
          : state,
        "output",
        `${event.label}...`,
      );
    case "progress":
      if (!running || running.percent === event.percent) return state;
      return { ...state, running: { ...running, percent: event.percent } };
    case "stage_finished": {
      const label = running?.stage ?? "Stage";
      const took = event.seconds === null ? "" : ` in ${event.seconds} s`;
      return appendLog(
        running ? { ...state, running: { ...running, percent: 100 } } : state,
        "output",
        `${label}: done${took}`,
      );
    }
  }
}

// --- selectors ---------------------------------------------------------

/** The detected programmer's chip-list id, or `null` when none is detected or it has no list. */
export function detectedProgrammer(state: DeviceState): Programmer | null {
  const { status, device } = state.programmer;
  if (status !== "found" || !device) return null;
  return programmerFromModel(device.programmer);
}

/**
 * Whether the detected programmer loads its bitstreams from `algorithm.xml`
 * and burnwright can point it at one: the T76.
 */
export function needsAlgorithmFile(state: DeviceState): boolean {
  return detectedProgrammer(state) === "t76";
}

/** Whose chip list the picker searches: the detected programmer's, else the one chosen by hand. */
export function activeProgrammer(state: DeviceState): Programmer {
  return detectedProgrammer(state) ?? state.programmer.manual;
}

/** The key a chip's lookup is stored under. */
export function lookupKey(programmer: Programmer, name: string): string {
  return `${programmer}\n${name}`;
}

/** The lookup for `name` under the active programmer, if one was started. */
export function lookupFor(state: DeviceState, name: string): ChipLookup | null {
  return state.chip.lookups[lookupKey(activeProgrammer(state), name)] ?? null;
}

/** The selected chip's lookup. */
export function selectedLookup(state: DeviceState): ChipLookup | null {
  const { selected } = state.chip;
  return selected ? lookupFor(state, selected.name) : null;
}

/** The selected chip's details, once they're in. */
export function selectedInfo(state: DeviceState): ChipInfo | null {
  const lookup = selectedLookup(state);
  return lookup?.status === "ready" ? lookup.info : null;
}

/** The recent chips that are in the active programmer's list. */
export function visibleRecent(state: DeviceState): RecentChip[] {
  const list = chipListOf(activeProgrammer(state));
  return state.chip.recent.filter((r) => chipListOf(r.programmer) === list);
}

/**
 * What replacing or dropping the buffer would lose, or `null` when a file
 * has all of it. A chip read counts until it's saved, edited or not: the
 * chip it came from may not read the same way twice.
 */
export function unsavedBuffer(buffer: BufferState | null): Unsaved | null {
  if (!buffer) return null;
  if (buffer.source.kind === "chip" && buffer.path === null) return "read";
  const edits =
    buffer.saved === buffer.original ? buffer.edited : buffer.bytes !== buffer.saved;
  return edits ? "edits" : null;
}

/** The write or erase that stopping now would leave half-done, if one is running. */
export function mutatingOp(
  state: DeviceState,
): { op: "write" | "erase"; chip: string } | null {
  const running = state.running;
  if (!running || running.phase !== "main") return null;
  if (running.op !== "write" && running.op !== "erase") return null;
  return { op: running.op, chip: running.chip };
}

/** How the buffer compares with the selected chip. */
export function bufferSizeCheck(state: DeviceState): SizeCheck {
  return checkSize(state.buffer?.bytes.length ?? null, selectedInfo(state));
}

/** Whether an operation can start now, and if not, why. */
export interface Availability {
  enabled: boolean;
  reason: string | null;
}

const READY: Availability = { enabled: true, reason: null };
const no = (reason: string): Availability => ({ enabled: false, reason });

/** Whether Auto can run: a programmer to ask, and nothing else using it. */
export function autoAvailability(state: DeviceState): Availability {
  if (state.running) return no("An operation is running.");
  if (state.chip.auto?.status === "running") return no("Auto is reading the chip's ID.");
  if (state.programmer.status === "detecting") return no("Looking for a programmer.");
  if (state.programmer.status !== "found") return no("Detect a programmer first.");
  return READY;
}

export function operationAvailability(state: DeviceState, op: OpKind): Availability {
  if (state.running) return no("Another operation is running.");
  if (state.chip.auto?.status === "running") return no("Auto is reading the chip's ID.");
  if (state.fileBusy === "opening") return no("A file is being opened.");
  if (state.fileBusy === "saving") return no("The buffer is being saved.");
  if (state.fileBusy === "choosing_algorithms") {
    return no("The algorithm file is being chosen.");
  }
  if (state.programmer.status === "detecting") return no("Looking for a programmer.");
  if (state.programmer.status !== "found") return no("No programmer detected.");
  const { selected } = state.chip;
  if (!selected) return no("Pick a chip first.");
  const lookup = selectedLookup(state);
  if (!lookup || lookup.status === "loading") return no("Loading the chip's details.");
  if (lookup.status === "error") {
    return no(`burnwright has no details for ${selected.name}, so it can't work on it.`);
  }
  if (lookup.info.kind === "logic") {
    return no(
      `${selected.name} is a logic IC. minipro can only test it: there is nothing to read, write or erase.`,
    );
  }
  if (op === "verify" || op === "write") {
    if (!state.buffer) return no("Open a file or read a chip first: the buffer is empty.");
    if (state.buffer.bytes.length === 0) return no("The buffer has no bytes in it.");
  }
  return READY;
}

/** The log as plain text, for the clipboard. */
export function logText(log: readonly LogLine[]): string {
  return log
    .map((line) => {
      if (line.kind === "heading") return `== ${line.text} ==`;
      if (line.kind === "command") return `$ ${line.text}`;
      return line.text;
    })
    .join("\n");
}
