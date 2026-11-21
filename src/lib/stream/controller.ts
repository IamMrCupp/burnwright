// Runs the stream page: turns its server on and off as the setting says,
// and tells it what the device screen is doing.
//
// It watches the device controller and sends `streamStatus` of each new
// state, and only that. The backend is passed in, so the whole flow runs in
// a test against a fake.
import type { DeviceState } from "../device/state";
import {
  DEFAULT_STREAM_SETTINGS,
  isStreamPort,
  type StreamSettings,
  type StreamSettingsStore,
} from "./settings";
import { streamStatus, type StreamStatus } from "./status";

/** Where the server stands (mirrors `stream::StreamServerState`). */
export interface StreamServerState {
  running: boolean;
  /** The page's address, when the server is running. */
  url: string | null;
  /** Why it isn't running although it was asked to. */
  error: string | null;
}

/** The two commands in `src-tauri/src/stream/mod.rs`. */
export interface StreamBackend {
  /** Turn the server on or off, or move it to another port. */
  configure(enabled: boolean, port: number): Promise<StreamServerState>;
  /** Replace what the page shows. */
  publish(status: StreamStatus): Promise<void>;
}

export interface StreamState {
  settings: StreamSettings;
  /** Where the server stands, once it has been asked. */
  server: StreamServerState | null;
}

export interface StreamDeps {
  backend: StreamBackend;
  /** The device screen whose work goes on the page. */
  device: {
    getState(): DeviceState;
    subscribe(listener: () => void): () => void;
  };
  /** Where the setting is kept between runs. Without one it lasts for the session. */
  settings?: StreamSettingsStore;
}

const OFF: StreamServerState = { running: false, url: null, error: null };

function failure(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "The stream page couldn't be started.";
}

export class StreamController {
  private state: StreamState;
  private readonly listeners = new Set<() => void>();
  private readonly backend: StreamBackend;
  private readonly device: StreamDeps["device"];
  private readonly store: StreamSettingsStore | undefined;

  /** The last `configure` asked for; each waits for the one before. */
  private applied: Promise<void> = Promise.resolve();
  /** What the page was last sent, as JSON, or `null` when it must be sent again. */
  private sent: string | null = null;
  /** A `publish` is on its way; the next waits for it, so they land in order. */
  private publishing = false;

  constructor(deps: StreamDeps) {
    this.backend = deps.backend;
    this.device = deps.device;
    this.store = deps.settings;
    const settings = deps.settings?.load() ?? DEFAULT_STREAM_SETTINGS;
    this.state = { settings, server: settings.enabled ? null : OFF };
    this.device.subscribe(this.publish);
    // Off is where the server starts: there's nothing to ask for.
    if (settings.enabled) void this.apply();
  }

  getState = (): StreamState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setState(next: StreamState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  /** Serve the page, or stop serving it. */
  setEnabled = (enabled: boolean): Promise<void> => {
    if (enabled === this.state.settings.enabled) return this.applied;
    return this.change({ ...this.state.settings, enabled });
  };

  /** Move the page to another port. One it can't be served on is ignored. */
  setPort = (port: number): Promise<void> => {
    if (!isStreamPort(port) || port === this.state.settings.port) return this.applied;
    return this.change({ ...this.state.settings, port });
  };

  private change(settings: StreamSettings): Promise<void> {
    this.store?.save(settings);
    this.setState({ ...this.state, settings });
    return this.apply();
  }

  /** Hand the setting to the server. Settles once the server has answered. */
  private apply(): Promise<void> {
    this.applied = this.applied.then(async () => {
      const { enabled, port } = this.state.settings;
      let server: StreamServerState;
      try {
        server = await this.backend.configure(enabled, port);
      } catch (err) {
        server = { running: false, url: null, error: failure(err) };
      }
      this.setState({ ...this.state, server });
      // A server that just came up may hold a status from before it went off.
      this.sent = null;
      this.publish();
    });
    return this.applied;
  }

  /** Send the page the device screen's status, if it has changed. */
  private readonly publish = (): void => {
    // With the server off there's nobody to tell.
    if (!this.state.server?.running || this.publishing) return;
    const status = streamStatus(this.device.getState());
    const json = JSON.stringify(status);
    if (json === this.sent) return;
    this.sent = json;
    this.publishing = true;
    this.backend
      .publish(status)
      .catch(() => {
        // Not sent after all.
        if (this.sent === json) this.sent = null;
      })
      .finally(() => {
        this.publishing = false;
        // Whatever changed while that one was on its way. A failed send is
        // left for the next change to retry, not looped on.
        if (this.sent !== null) this.publish();
      });
  };
}
