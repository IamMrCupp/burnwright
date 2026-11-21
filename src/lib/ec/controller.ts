// Drives the EC backup screen: holds its state, calls the session commands,
// and feeds the results to the reducer. It takes the commands and the
// system's panels as arguments, so the whole flow runs in a test against a
// fake of each.
//
// Rules it keeps:
// - One step at a time.
// - Nothing talks to the chip until every wiring check is ticked. Looking
//   for the CH341A is allowed before that: it doesn't touch the EC.
// - Unticking a wiring check closes the session. The wiring changed, so what
//   answered before may not be what's connected now.
// - It never writes to a chip. There's no command here that could.
import { CH341A, KB9012, type BenchApi, type ProgressEvent } from "../engine";
import {
  flashromReady,
  initialState,
  reducer,
  stepAvailability,
  type Action,
  type EcState,
  type EcStep,
} from "./state";

/** The session commands the screen uses. */
export type EcBench = Pick<
  BenchApi,
  | "flashromStatus"
  | "setFlashromPath"
  | "listProbes"
  | "openSession"
  | "backup"
  | "closeSession"
>;

/** Where the chosen flashrom is kept between runs. */
export interface FlashromPathStore {
  load(): string | null;
  /** Remember it; `null` forgets it. */
  save(path: string | null): void;
}

const FLASHROM_KEY = "burnwright.flashromPath";

/**
 * A store over `storage` (the browser's `localStorage`). A storage that
 * throws just means nothing is remembered.
 */
export function flashromPathStore(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
): FlashromPathStore {
  return {
    load() {
      try {
        const path = storage.getItem(FLASHROM_KEY);
        return path && path.trim() !== "" ? path : null;
      } catch {
        return null;
      }
    },
    save(path) {
      try {
        if (path === null) storage.removeItem(FLASHROM_KEY);
        else storage.setItem(FLASHROM_KEY, path);
      } catch {
        // Not worth interrupting anyone for.
      }
    },
  };
}

export interface EcDeps {
  bench: EcBench;
  /** The system's open panel, for pointing at a flashrom. `null` when the user backs out. */
  chooseFlashrom?: () => Promise<string | null>;
  /** Show a file in the system's file manager. */
  reveal?: (path: string) => Promise<void>;
  /** Where the chosen flashrom is kept between runs. Without one it lasts for the session. */
  flashromPath?: FlashromPathStore;
}

export class EcController {
  private state: EcState = initialState();
  private readonly listeners = new Set<() => void>();
  private readonly bench: EcBench;
  private readonly deps: EcDeps;
  /** Cancels the running step. */
  private abort: AbortController | null = null;
  /** The first look at flashrom and the CH341A, started once. */
  private opened: Promise<void> | null = null;

  constructor(deps: EcDeps) {
    this.bench = deps.bench;
    this.deps = deps;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): EcState => this.state;

  private dispatch(action: Action): void {
    const next = reducer(this.state, action);
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  /** Whether the user can pick a flashrom from a file panel. */
  get canChooseFlashrom(): boolean {
    return this.deps.chooseFlashrom !== undefined;
  }

  /** Whether a saved backup can be shown in the file manager. */
  get canReveal(): boolean {
    return this.deps.reveal !== undefined;
  }

  /**
   * The screen came up: find flashrom (handing back a remembered path
   * first), then look for the CH341A. Only the first call does anything.
   */
  open = (): Promise<void> => {
    this.opened ??= this.firstLook();
    return this.opened;
  };

  private async firstLook(): Promise<void> {
    const remembered = this.deps.flashromPath?.load() ?? null;
    await this.refreshFlashrom(
      () =>
        remembered === null
          ? this.bench.flashromStatus()
          : this.bench.setFlashromPath(remembered),
      remembered,
    );
    await this.lookOnce();
  }

  /** Look for the CH341A when there's a flashrom to do it and nobody has looked yet. */
  private async lookOnce(): Promise<void> {
    if (flashromReady(this.state) && this.state.probe.status === "unknown") {
      await this.lookForProgrammer();
    }
  }

  /** Ask the backend where flashrom stands. `chosen` records a change of the chosen path. */
  private async refreshFlashrom(
    ask: () => ReturnType<EcBench["flashromStatus"]>,
    chosen?: string | null,
  ): Promise<void> {
    this.dispatch({ type: "flashrom_busy" });
    try {
      this.dispatch({ type: "flashrom", status: await ask(), chosen });
    } catch (error) {
      // The status commands don't reject; a broken backend still shouldn't
      // leave the screen saying "looking".
      this.dispatch({
        type: "flashrom",
        status: {
          availability: { status: "missing", reason: String(error) },
          path: null,
          source: null,
        },
        chosen,
      });
    }
  }

  /** Ask again whether there's a flashrom: the user may have just installed one. */
  checkFlashrom = async (): Promise<void> => {
    if (this.state.flashromBusy || this.state.running) return;
    await this.refreshFlashrom(() => this.bench.flashromStatus());
    await this.lookOnce();
  };

  /** Pick a flashrom from a file panel and use it from now on. */
  chooseFlashrom = async (): Promise<void> => {
    const choose = this.deps.chooseFlashrom;
    if (!choose || this.state.flashromBusy || this.state.running) return;
    this.dispatch({ type: "flashrom_busy" });
    let path: string | null;
    try {
      path = await choose();
    } catch {
      path = null;
    }
    if (path === null) {
      this.dispatch({ type: "flashrom_idle" });
      return;
    }
    const chosen = path;
    await this.refreshFlashrom(() => this.bench.setFlashromPath(chosen), chosen);
    this.deps.flashromPath?.save(chosen);
    await this.lookOnce();
  };

  /** Go back to finding flashrom on the machine. */
  clearFlashromPath = async (): Promise<void> => {
    if (this.state.flashromBusy || this.state.running) return;
    await this.refreshFlashrom(() => this.bench.setFlashromPath(null), null);
    this.deps.flashromPath?.save(null);
    await this.lookOnce();
  };

  /** Tick or untick a wiring check. Unticking closes the session. */
  setWiring = (id: string, checked: boolean): void => {
    if (this.state.running) return;
    const session = this.state.session;
    this.dispatch({ type: "wiring", id, checked });
    if (!checked && session) {
      void this.bench.closeSession(session.id).catch(() => {});
    }
  };

  /** Run `step`: start it, pass its progress on, and record how it ended. */
  private async run<T>(
    step: EcStep,
    call: (options: {
      onProgress: (event: ProgressEvent) => void;
      signal: AbortSignal;
    }) => Promise<T>,
    done: (result: T) => Action,
  ): Promise<void> {
    if (!stepAvailability(this.state, step).enabled) return;
    const abort = new AbortController();
    this.abort = abort;
    this.dispatch({ type: "started", step });
    try {
      const result = await call({
        onProgress: (event) => this.dispatch({ type: "progress", event }),
        signal: abort.signal,
      });
      this.dispatch(done(result));
    } catch (error) {
      this.dispatch({ type: "failed", step, error });
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }

  /** Whether a CH341A is plugged in. Doesn't touch the EC. */
  lookForProgrammer = (): Promise<void> =>
    this.run(
      "probe",
      (options) => this.bench.listProbes(options),
      (probes) => ({ type: "probed", probes }),
    );

  /** Ask the chip what it is and open a session on it. */
  identify = (): Promise<void> =>
    this.run(
      "identify",
      (options) => this.bench.openSession(CH341A, KB9012, options),
      (session) => ({ type: "identified", session }),
    );

  /** Read the chip and save it. */
  backup = (): Promise<void> => {
    const session = this.state.session;
    if (!session) return Promise.resolve();
    return this.run(
      "backup",
      (options) => this.bench.backup(session.id, options),
      (backup) => ({ type: "backed_up", backup }),
    );
  };

  /** Stop the running step. Nothing here writes, so there's nothing to ask first. */
  cancel = (): void => {
    if (!this.abort || !this.state.running || this.state.running.cancelling) return;
    this.dispatch({ type: "cancelling" });
    this.abort.abort();
  };

  /** Show the saved backup in the system's file manager. */
  revealBackup = async (): Promise<void> => {
    const backup = this.state.backup;
    if (!backup || !this.deps.reveal) return;
    try {
      await this.deps.reveal(backup.path);
    } catch (error) {
      this.dispatch({
        type: "log",
        kind: "error",
        text: `Couldn't show ${backup.path}: ${String(error)}`,
      });
    }
  };

  clearLog = (): void => {
    this.dispatch({ type: "clear_log" });
  };
}
