import { useEffect, useState, useSyncExternalStore } from "react";
import { AppearancePicker } from "./components/appearance";
import { DeviceScreen } from "./components/device";
import { EcScreen } from "./components/ec";
import { createEditorMemory } from "./components/hexview";
import type { AppearanceController } from "./lib/appearance";
import { StreamControl } from "./components/stream";
import type { DeviceController } from "./lib/device/controller";
import type { EcController } from "./lib/ec/controller";
import type { StreamController } from "./lib/stream/controller";
import { errorMessage, type AppInfo } from "./lib/engine";
import "./App.css";

export interface AppProps {
  controller: DeviceController;
  /** The laptop EC backup screen. */
  ec: EcController;
  /** The light / dark choice, shown above the version line on both benches. */
  appearance: AppearanceController;
  /** The page OBS loads to put the programmer bench on a live stream. */
  stream: StreamController;
  /** burnwright's and the bundled minipros' versions, for the footer. */
  loadAppInfo: () => Promise<AppInfo>;
  /**
   * Opens the third-party notices this copy was installed with. Without it
   * the footer has no Licences button.
   */
  openNotices?: () => Promise<void>;
}

/** Which bench is on screen: the programmer's socket, or a laptop's EC. */
type Mode = "programmer" | "ec";

const MODES: readonly { id: Mode; label: string }[] = [
  { id: "programmer", label: "Programmer" },
  { id: "ec", label: "Laptop EC" },
];

/**
 * The app: a switch between the two benches, and the one that's chosen. It
 * looks for a programmer as it opens. Each bench keeps its state in its
 * controller, and what the hex editor is in the middle of is kept here, so
 * switching away and back loses nothing, and an operation running on one
 * carries on while the other is shown.
 */
function App({ controller, ec, appearance, stream, loadAppInfo, openNotices }: AppProps) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [noticesError, setNoticesError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("programmer");
  // The programmer's screen is taken down while the EC's is up. Its hex
  // editor's edits, undo history and cursor wait here until it's back.
  const [editorMemory] = useState(createEditorMemory);
  // The window is on a stream: both benches draw their paths hidden.
  const hidePaths = useSyncExternalStore(
    stream.subscribe,
    () => stream.getState().settings.hidePaths,
  );

  useEffect(() => {
    loadAppInfo().then(setInfo, () => setInfo(null));
  }, [loadAppInfo]);

  useEffect(() => {
    void controller.detect();
  }, [controller]);

  const showNotices = openNotices
    ? () => {
        setNoticesError(null);
        openNotices().catch((err: unknown) => setNoticesError(errorMessage(err)));
      }
    : null;

  const footer = (
    <>
      <AppearancePicker controller={appearance} />
      {info
        ? `burnwright v${info.version} · minipro ${info.minipro} · T76 build ${info.minipro_t76}`
        : "burnwright"}
      {showNotices && (
        <button
          type="button"
          className="button-quiet app-licences"
          title="burnwright is GPL-3.0-or-later. This opens the licences of everything built into it."
          onClick={showNotices}
        >
          Licences
        </button>
      )}
      {noticesError && (
        <p className="notice notice-error" role="alert">
          Couldn&rsquo;t open the licences: {noticesError}
        </p>
      )}
    </>
  );

  return (
    <div className="app">
      <header className="app-bar">
        <nav className="app-modes" aria-label="Bench">
          {MODES.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-pressed={mode === id}
              onClick={() => setMode(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <StreamControl controller={stream} />
      </header>
      <div className="app-bench">
        {mode === "programmer" ? (
          <DeviceScreen
            controller={controller}
            footer={footer}
            hidePaths={hidePaths}
            editorMemory={editorMemory}
          />
        ) : (
          <EcScreen controller={ec} footer={footer} hidePaths={hidePaths} />
        )}
      </div>
    </div>
  );
}

export default App;
