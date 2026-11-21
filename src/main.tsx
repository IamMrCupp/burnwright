import React from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import App, { type AppProps } from "./App";
import { DeviceController } from "./lib/device/controller";
import { guardWindowClose, tauriDeps } from "./lib/device/tauri";
import { EcController } from "./lib/ec/controller";
import { tauriEcDeps } from "./lib/ec/tauri";
import { engine } from "./lib/engine";

async function setup(): Promise<AppProps> {
  // `pnpm dev` opened in a plain browser has no Tauri backend: use the fake
  // engine there. A release build never takes this branch or ships it.
  if (import.meta.env.DEV && !isTauri()) {
    const { previewSetup } = await import("./dev/preview");
    const { deps, ecDeps, loadAppInfo } = previewSetup();
    return {
      controller: new DeviceController(deps),
      ec: new EcController(ecDeps),
      loadAppInfo,
    };
  }
  const controller = new DeviceController(tauriDeps());
  guardWindowClose(controller);
  return { controller, ec: new EcController(tauriEcDeps()), loadAppInfo: engine.appInfo };
}

void setup().then((props) => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App {...props} />
    </React.StrictMode>,
  );
});
