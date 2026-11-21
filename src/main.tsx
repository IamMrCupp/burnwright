import React from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import App, { type AppProps } from "./App";
import { AppearanceController, appearanceStore } from "./lib/appearance";
import { DeviceController } from "./lib/device/controller";
import { guardWindowClose, setWindowTheme, tauriDeps } from "./lib/device/tauri";
import { engine } from "./lib/engine";

// The look goes on the page before anything is drawn on it.
const appearance = new AppearanceController({
  store: appearanceStore(window.localStorage),
  root: document.documentElement,
  systemDark: window.matchMedia("(prefers-color-scheme: dark)"),
  setWindowTheme: isTauri() ? setWindowTheme : undefined,
});
appearance.start();

async function setup(): Promise<Omit<AppProps, "appearance">> {
  // `pnpm dev` opened in a plain browser has no Tauri backend: use the fake
  // engine there. A release build never takes this branch or ships it.
  if (import.meta.env.DEV && !isTauri()) {
    const { previewSetup } = await import("./dev/preview");
    const { deps, loadAppInfo } = previewSetup();
    return { controller: new DeviceController(deps), loadAppInfo };
  }
  const controller = new DeviceController(tauriDeps());
  guardWindowClose(controller);
  return { controller, loadAppInfo: engine.appInfo };
}

void setup().then((props) => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App {...props} appearance={appearance} />
    </React.StrictMode>,
  );
});
