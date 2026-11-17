import { useEffect, useState } from "react";
import { DeviceScreen } from "./components/device";
import type { DeviceController } from "./lib/device/controller";
import type { AppInfo } from "./lib/engine";
import "./App.css";

export interface AppProps {
  controller: DeviceController;
  /** burnwright's and the bundled minipros' versions, for the footer. */
  loadAppInfo: () => Promise<AppInfo>;
}

/** The app: the device screen, with a look for a programmer as it opens. */
function App({ controller, loadAppInfo }: AppProps) {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    loadAppInfo().then(setInfo, () => setInfo(null));
  }, [loadAppInfo]);

  useEffect(() => {
    void controller.detect();
  }, [controller]);

  return (
    <DeviceScreen
      controller={controller}
      footer={
        info
          ? `burnwright v${info.version} · minipro ${info.minipro} · T76 build ${info.minipro_t76}`
          : "burnwright"
      }
    />
  );
}

export default App;
