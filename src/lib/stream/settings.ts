// The streaming settings, kept between runs in the webview's
// localStorage like the app's others. The Rust side holds it for the
// session only, so the controller hands it back at startup.

export interface StreamSettings {
  /** Whether the page is served. Off until the user turns it on. */
  enabled: boolean;
  port: number;
  /**
   * Hide file paths in the app's own window, for when OBS captures it. On
   * its own switch: it has nothing to do with whether the page is served.
   */
  hidePaths: boolean;
}

/** Next door to benchhud's 8780, so the two can run on one bench. */
export const DEFAULT_STREAM_PORT = 8790;

export const MIN_STREAM_PORT = 1024;
export const MAX_STREAM_PORT = 65535;

export const DEFAULT_STREAM_SETTINGS: StreamSettings = {
  enabled: false,
  port: DEFAULT_STREAM_PORT,
  hidePaths: false,
};

/** Whether the page can be served on `port`. */
export function isStreamPort(port: unknown): port is number {
  return (
    typeof port === "number" &&
    Number.isInteger(port) &&
    port >= MIN_STREAM_PORT &&
    port <= MAX_STREAM_PORT
  );
}

export interface StreamSettingsStore {
  load(): StreamSettings;
  save(settings: StreamSettings): void;
}

const KEY = "burnwright.stream";

/**
 * A store over `storage` (the browser's `localStorage`). Anything it can't
 * make sense of reads as the default, which is off: a damaged setting must
 * never turn the page on.
 */
export function streamSettingsStore(
  storage: Pick<Storage, "getItem" | "setItem">,
): StreamSettingsStore {
  return {
    load() {
      try {
        const stored: unknown = JSON.parse(storage.getItem(KEY) ?? "null");
        if (typeof stored !== "object" || stored === null) return DEFAULT_STREAM_SETTINGS;
        const { enabled, port, hidePaths } = stored as Record<string, unknown>;
        return {
          enabled: enabled === true,
          port: isStreamPort(port) ? port : DEFAULT_STREAM_PORT,
          hidePaths: hidePaths === true,
        };
      } catch {
        return DEFAULT_STREAM_SETTINGS;
      }
    },
    save({ enabled, port, hidePaths }) {
      try {
        storage.setItem(KEY, JSON.stringify({ enabled, port, hidePaths }));
      } catch {
        // Not worth interrupting anyone for.
      }
    },
  };
}
