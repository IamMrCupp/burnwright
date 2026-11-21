// The EC backup screen's state: what's known about flashrom, the CH341A and
// the chip, which wiring checks are ticked, the step that's running, and how
// the last one ended. Everything here is a plain value and a pure function;
// the controller calls the backend and feeds the results in.
//
// The screen does one thing: back up an ENE KB9012 in-circuit. It can't
// write to one.
import {
  errorMessage,
  isEngineError,
  type FlashromStatus,
  type ProbeInfo,
  type ProgressEvent,
  type SavedBackup,
  type SessionInfo,
} from "../engine";
import { LOG_LIMIT, type LogKind, type LogLine } from "../device/state";
import { formatSize } from "../device/format";

/** The things the screen runs against the hardware. */
export type EcStep = "probe" | "identify" | "backup";

/** What each step's button says. */
export const STEP_LABELS: Record<EcStep, string> = {
  probe: "Look for the CH341A",
  identify: "Identify",
  backup: "Back up",
};

/** Each step as a thing that can fail or be cancelled. */
const STEP_NOUNS: Record<EcStep, string> = {
  probe: "Search",
  identify: "Identify",
  backup: "Backup",
};

/** Each step as something going on. */
const STEP_RUNNING: Record<EcStep, string> = {
  probe: "Looking for the CH341A.",
  identify: "Identify is running.",
  backup: "A backup is running.",
};

/** One line of the checklist the user ticks before anything touches the board. */
export interface WiringCheck {
  id: string;
  label: string;
  /** Why it matters, or how to do it. */
  detail: string;
}

/**
 * What has to be true before burnwright talks to the EC. None of it can be
 * checked from software, so the user ticks each one.
 *
 * Where these come from: the 5 V data lines are in flashrom's own CH341A
 * notes; pins 59 to 62 and pin 42 are from the notes on flashrom's KB9012
 * (EDI) support; "stopped while it runs" is what flashrom's EDI code does.
 */
export const WIRING: readonly WiringCheck[] = [
  {
    id: "off",
    label: "The laptop is shut down, with its battery or adapter still connected.",
    detail:
      "The EC runs from standby power, and it has to stay powered to answer. burnwright stops it while it reads, so the laptop can't be running.",
  },
  {
    id: "levels",
    label: "The CH341A's data lines are at 3.3 V, not 5 V.",
    detail:
      "The common black CH341A board drives its data lines at close to 5 V whatever its jumper says. That can kill the EC. Measure a data pin, or use a board that's been fixed.",
  },
  {
    id: "ground",
    label: "Ground is connected, and it went on first.",
    detail: "CH341A GND to a ground point on the board, before any signal wire.",
  },
  {
    id: "signals",
    label: "CS, CLK, MOSI and MISO are on the KB9012's debug pins.",
    detail:
      "Pins 59 (CS), 60 (CLK), 61 (data in, from MOSI) and 62 (data out, to MISO). They usually come out on the keyboard connector. Which pads they are is different on every board: check the schematic.",
  },
  {
    id: "no-power",
    label: "The CH341A's 3.3 V and 5 V pins are not connected.",
    detail: "The board powers the EC. A second supply from the programmer fights it.",
  },
];

/** The step that's running. */
export interface EcRunning {
  step: EcStep;
  /** flashrom's name for the current stage, e.g. "Reading flash". */
  stage: string | null;
  /** 0 to 100, or `null` when flashrom hasn't said. */
  percent: number | null;
  /** Which read of the chip this is, during a backup: 1, then 2 on a live board. */
  pass: number;
  /** A cancel has been sent and the step hasn't stopped yet. */
  cancelling: boolean;
}

/** How the last step ended, as the screen words it. */
export interface EcOutcome {
  step: EcStep;
  tone: "ok" | "warning" | "error";
  title: string;
  /** Paragraphs under the title. */
  details: string[];
}

/** Whether a CH341A is plugged in, as far as the last look found. */
export type ProbeState =
  | { status: "unknown" }
  | { status: "found"; info: ProbeInfo }
  | { status: "none" };

export interface EcState {
  /** What `flashromStatus` said; `null` until it has been asked. */
  flashrom: FlashromStatus | null;
  /** A status check, or the file panel for choosing a flashrom, is under way. */
  flashromBusy: boolean;
  /** The flashrom the user pointed at, when they did. It may not be there. */
  flashromChosen: string | null;
  probe: ProbeState;
  /** The wiring checks that are ticked, by id. */
  wiring: Record<string, boolean>;
  /** The chip that answered, while its session is open. */
  session: SessionInfo | null;
  /** The backup taken in this session. */
  backup: SavedBackup | null;
  running: EcRunning | null;
  outcome: EcOutcome | null;
  log: LogLine[];
  nextLogId: number;
}

export function initialState(): EcState {
  return {
    flashrom: null,
    flashromBusy: false,
    flashromChosen: null,
    probe: { status: "unknown" },
    wiring: {},
    session: null,
    backup: null,
    running: null,
    outcome: null,
    log: [],
    nextLogId: 1,
  };
}

export type Action =
  | { type: "flashrom_busy" }
  /** `chosen` is the path the user pointed at; left out, it stays as it was. */
  | { type: "flashrom"; status: FlashromStatus; chosen?: string | null }
  | { type: "flashrom_idle" }
  | { type: "wiring"; id: string; checked: boolean }
  | { type: "started"; step: EcStep }
  | { type: "progress"; event: ProgressEvent }
  | { type: "cancelling" }
  | { type: "probed"; probes: ProbeInfo[] }
  | { type: "identified"; session: SessionInfo }
  | { type: "backed_up"; backup: SavedBackup }
  | { type: "failed"; step: EcStep; error: unknown }
  | { type: "log"; kind: LogKind; text: string }
  | { type: "clear_log" };

export function reducer(state: EcState, action: Action): EcState {
  switch (action.type) {
    case "flashrom_busy":
      return { ...state, flashromBusy: true };
    case "flashrom_idle":
      return { ...state, flashromBusy: false };
    case "flashrom": {
      const same = state.flashrom?.path === action.status.path;
      return {
        ...state,
        flashrom: action.status,
        flashromBusy: false,
        flashromChosen: action.chosen === undefined ? state.flashromChosen : action.chosen,
        // A different flashrom hasn't looked for the programmer yet.
        probe: same ? state.probe : { status: "unknown" },
      };
    }
    case "wiring": {
      const wiring = { ...state.wiring, [action.id]: action.checked };
      // Unticking says the wiring changed: whatever answered before may not
      // be what's connected now.
      return action.checked
        ? { ...state, wiring }
        : { ...state, wiring, session: null, backup: null, outcome: null };
    }
    case "started":
      return appendLog(
        {
          ...state,
          outcome: null,
          running: {
            step: action.step,
            stage: null,
            percent: null,
            pass: 0,
            cancelling: false,
          },
        },
        "heading",
        STEP_LABELS[action.step],
      );
    case "progress":
      return applyProgress(state, action.event);
    case "cancelling":
      return state.running
        ? { ...state, running: { ...state.running, cancelling: true } }
        : state;
    case "probed": {
      const info = action.probes[0];
      return {
        ...state,
        running: null,
        probe: info ? { status: "found", info } : { status: "none" },
        outcome: null,
      };
    }
    case "identified":
      return {
        ...state,
        running: null,
        session: action.session,
        backup: null,
        // Something answered through it, so it's there.
        probe:
          state.probe.status === "found"
            ? state.probe
            : {
                status: "found",
                info: {
                  backend: action.session.backend,
                  probe: action.session.probe,
                  model: "CH341A",
                  firmware: null,
                },
              },
        outcome: identifiedOutcome(action.session),
      };
    case "backed_up":
      return {
        ...state,
        running: null,
        backup: action.backup,
        outcome: backedUpOutcome(action.backup, state.session),
      };
    case "failed": {
      const kind = isEngineError(action.error) ? action.error.kind : null;
      return {
        ...state,
        running: null,
        // The programmer isn't there, so neither is what was found on it.
        probe: kind === "no_programmer" ? { status: "none" } : state.probe,
        session:
          action.step === "identify" || kind === "no_programmer" || kind === "invalid_input"
            ? null
            : state.session,
        outcome: failureOutcome(action.step, action.error),
      };
    }
    case "log":
      return appendLog(state, action.kind, action.text);
    case "clear_log":
      return { ...state, log: [] };
  }
}

function appendLog(state: EcState, kind: LogKind, text: string): EcState {
  const line: LogLine = { id: state.nextLogId, kind, text };
  const log =
    state.log.length >= LOG_LIMIT
      ? [...state.log.slice(state.log.length - LOG_LIMIT + 1), line]
      : [...state.log, line];
  return { ...state, log, nextLogId: state.nextLogId + 1 };
}

function applyProgress(state: EcState, event: ProgressEvent): EcState {
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
          ? {
              ...state,
              running: {
                ...running,
                stage: event.label,
                percent: null,
                pass: running.pass + 1,
              },
            }
          : state,
        "output",
        `${event.label}...`,
      );
    case "progress":
      if (!running || running.percent === event.percent) return state;
      return { ...state, running: { ...running, percent: event.percent } };
    case "stage_finished":
      return appendLog(
        running ? { ...state, running: { ...running, percent: 100 } } : state,
        "output",
        `${running?.stage ?? "Stage"}: done`,
      );
  }
}

// --- outcomes ----------------------------------------------------------

function identifiedOutcome(session: SessionInfo): EcOutcome {
  const { chip } = session;
  const facts = [
    chip.size === null ? null : `${formatSize(chip.size)} of flash`,
    chip.fingerprint ? `ID: ${chip.fingerprint}` : null,
  ].filter(Boolean);
  return {
    step: "identify",
    tone: "ok",
    title: `${chip.target.part} answered`,
    details: [
      ...(chip.detail ? [chip.detail] : []),
      ...(facts.length ? [`${facts.join(". ")}.`] : []),
      "The EC is running again. Back it up next: it's stopped once more while that reads.",
    ],
  };
}

function backedUpOutcome(backup: SavedBackup, session: SessionInfo | null): EcOutcome {
  return {
    step: "backup",
    tone: "ok",
    title: "Backup saved",
    details: [
      session?.capabilities.in_circuit
        ? "The chip was read twice and both reads match."
        : "The chip was read and saved.",
      `${formatSize(backup.len)}, with its SHA-256 in a .sha256 file next to it.`,
    ],
  };
}

/** How a failed step reads on screen: what happened, then what to try. */
export function failureOutcome(step: EcStep, error: unknown): EcOutcome {
  const message = errorMessage(error);
  const kind = isEngineError(error) ? error.kind : null;
  const failed = (title: string, ...details: string[]): EcOutcome => ({
    step,
    tone: "error",
    title,
    details,
  });
  switch (kind) {
    case "cancelled":
      return {
        step,
        tone: "warning",
        title: `${STEP_NOUNS[step]} cancelled`,
        details: [
          step === "backup" ? "Nothing was saved." : "Nothing changed.",
          "burnwright lets the EC run again after a cancel. The log says so if that didn't work.",
        ],
      };
    case "flashrom_not_found":
      return failed("flashrom isn't there to run", message);
    case "no_programmer":
      return failed(
        "No CH341A found",
        "flashrom couldn't open the CH341A. Check that it's plugged in.",
        "On Linux, flashrom says the same thing when it isn't allowed to open the device: that takes a udev rule for USB ID 1a86:5512.",
      );
    case "no_chip":
      return failed(
        "Nothing answered",
        message,
        "People report a KB9012 that only answers every second try. Identify again before you move any wires.",
        "Some EC firmware turns the debug port off. Grounding pin 42 of the KB9012 holds its CPU in reset, which brings the port back.",
      );
    case "chip_id_mismatch":
      return failed(
        "A different chip answered",
        message,
        "burnwright reads a KB9012 over EDI and nothing else so far.",
      );
    case "inconsistent_reads":
      return failed(
        "The two reads don't match",
        message,
        "Nothing was saved. This is usually a loose wire, or an EC that's still running: check the connections and that the laptop is off.",
      );
    case "busy":
      return failed(
        "The CH341A is busy",
        "Another operation is using it. Wait for that to finish.",
      );
    case "invalid_input":
      return failed(`${STEP_NOUNS[step]} didn't run`, message, "Identify the chip again.");
    default:
      return failed(`${STEP_NOUNS[step]} failed`, message);
  }
}

// --- selectors ---------------------------------------------------------

/** Whether flashrom was found. `false` until the status has been asked. */
export function flashromReady(state: EcState): boolean {
  return state.flashrom?.availability.status === "ready";
}

/** Whether every wiring check is ticked. */
export function wiringDone(state: EcState): boolean {
  return WIRING.every((check) => state.wiring[check.id] === true);
}

export interface Availability {
  enabled: boolean;
  /** Why it can't start now. */
  reason: string | null;
}

const READY: Availability = { enabled: true, reason: null };
const off = (reason: string): Availability => ({ enabled: false, reason });

/** Whether `step` can start now, and if not, why. */
export function stepAvailability(state: EcState, step: EcStep): Availability {
  if (state.running) {
    return off(STEP_RUNNING[state.running.step]);
  }
  if (!flashromReady(state)) {
    return off(
      state.flashrom === null ? "Looking for flashrom." : "flashrom isn't installed.",
    );
  }
  if (step === "probe") return READY;
  if (!wiringDone(state)) return off("Tick every wiring check first.");
  if (step === "identify") return READY;
  if (!state.session) return off("Identify the chip first.");
  return READY;
}

/** What the progress line says for the running step. */
export function progressLabel(running: EcRunning, session: SessionInfo | null): string {
  if (running.cancelling) return "Stopping, then letting the EC run again";
  if (running.step === "probe") return "Looking for the CH341A";
  if (running.step === "identify") return "Asking the chip what it is";
  const reads = session?.capabilities.in_circuit ? 2 : 1;
  const pass = Math.min(Math.max(running.pass, 1), reads);
  return reads === 1
    ? "Reading the chip"
    : pass === 1
      ? "Reading the chip (1 of 2)"
      : "Reading the chip again to check the first read (2 of 2)";
}
