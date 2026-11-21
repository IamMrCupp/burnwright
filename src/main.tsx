import React from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import App, { type AppProps } from "./App";
import { AppearanceController, appearanceStore } from "./lib/appearance";
import { DeviceController } from "./lib/device/controller";
import { guardWindowClose, setWindowTheme, tauriDeps, tauriThemes } from "./lib/device/tauri";
import { EcController } from "./lib/ec/controller";
import { tauriEcDeps } from "./lib/ec/tauri";
import { engine } from "./lib/engine";
import type { ThemeSource } from "./lib/theme";
import { StreamController } from "./lib/stream/controller";
import { tauriStreamDeps } from "./lib/stream/tauri";

/** The themes folder: the real one in the app, a pretend one under `pnpm dev`. */
function themeSource(): ThemeSource | undefined {
  if (isTauri()) return tauriThemes();
  if (import.meta.env.DEV) {
    const preview = import("./dev/previewThemes");
    return {
      list: async () => (await preview).previewThemes.list(),
      openFolder: async () => (await preview).previewThemes.openFolder(),
    };
  }
  return undefined;
}

// The look goes on the page before anything is drawn on it.
const appearance = new AppearanceController({
  store: appearanceStore(window.localStorage),
  root: document.documentElement,
  systemDark: window.matchMedia("(prefers-color-scheme: dark)"),
  setWindowTheme: isTauri() ? setWindowTheme : undefined,
  themes: themeSource(),
});
appearance.start();

async function setup(): Promise<Omit<AppProps, "appearance">> {
  // `pnpm dev` opened in a plain browser has no Tauri backend: use the fake
  // engine there. `VITE_FAKE_ENGINE=1 pnpm tauri dev` uses it in the app's
  // own window too, where the stream page's server is the real one. A
  // release build never takes this branch or ships it.
  if (import.meta.env.DEV && (!isTauri() || import.meta.env.VITE_FAKE_ENGINE)) {
    const { previewSetup } = await import("./dev/preview");
    const { deps, ecDeps, streamBackend, loadAppInfo } = previewSetup();
    const controller = new DeviceController(deps);
    return {
      controller,
      ec: new EcController(ecDeps),
      stream: new StreamController(
        isTauri()
          ? tauriStreamDeps(controller)
          : { backend: streamBackend, device: controller },
      ),
      loadAppInfo,
    };
  }
  const controller = new DeviceController(tauriDeps());
  guardWindowClose(controller);
  return {
    controller,
    ec: new EcController(tauriEcDeps()),
    stream: new StreamController(tauriStreamDeps(controller)),
    loadAppInfo: engine.appInfo,
  };
}

void setup().then((props) => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App {...props} appearance={appearance} />
    </React.StrictMode>,
  );
});
