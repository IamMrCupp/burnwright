import { useEffect, useState } from "react";
import { DeviceScreen } from "./components/device";
import { EcScreen } from "./components/ec";
import type { DeviceController } from "./lib/device/controller";
import type { EcController } from "./lib/ec/controller";
import type { AppInfo } from "./lib/engine";
import "./App.css";

export interface AppProps {
  controller: DeviceController;
  /** The laptop EC backup screen. */
  ec: EcController;
  /** burnwright's and the bundled minipros' versions, for the footer. */
  loadAppInfo: () => Promise<AppInfo>;
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
 * controller, so switching away and back loses nothing, and an operation
 * running on one carries on while the other is shown.
 */
function App({ controller, ec, loadAppInfo }: AppProps) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [mode, setMode] = useState<Mode>("programmer");

  useEffect(() => {
    loadAppInfo().then(setInfo, () => setInfo(null));
  }, [loadAppInfo]);

  useEffect(() => {
    void controller.detect();
  }, [controller]);

  const footer = info
    ? `burnwright v${info.version} · minipro ${info.minipro} · T76 build ${info.minipro_t76}`
    : "burnwright";

  return (
    <div className="app">
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
      <div className="app-bench">
        {mode === "programmer" ? (
          <DeviceScreen controller={controller} footer={footer} />
        ) : (
          <EcScreen controller={ec} footer={footer} />
        )}
      </div>
    </div>
  );
}

export default App;
