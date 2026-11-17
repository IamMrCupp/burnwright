// Settings kept between runs in the webview's localStorage. The Rust side
// holds them for the session only, so the controller hands them back at
// startup.

/** Where the device screen's settings are read from and written to. */
export interface SettingsStore {
  /** The `algorithm.xml` the user chose for a T76, if any. */
  loadAlgorithmPath(): string | null;
  /** Remember it; `null` forgets it. */
  saveAlgorithmPath(path: string | null): void;
}

const ALGORITHM_KEY = "burnwright.algorithmPath";

/**
 * A store over `storage` (the browser's `localStorage`). Only the path is
 * kept: the file stays where the user put it. A storage that throws
 * (private mode, a full disk) just means nothing is remembered.
 */
export function settingsStore(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
): SettingsStore {
  return {
    loadAlgorithmPath() {
      try {
        const path = storage.getItem(ALGORITHM_KEY);
        return path && path.trim() !== "" ? path : null;
      } catch {
        return null;
      }
    },
    saveAlgorithmPath(path) {
      try {
        if (path === null) storage.removeItem(ALGORITHM_KEY);
        else storage.setItem(ALGORITHM_KEY, path);
      } catch {
        // Not worth interrupting anyone for.
      }
    },
  };
}
