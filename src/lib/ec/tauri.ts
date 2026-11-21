// The EC backup screen's dependencies in the real app: the session
// commands, the system's open panel and file manager, and the webview's
// localStorage.
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { bench } from "../engine";
import { flashromPathStore, type EcDeps } from "./controller";

export function tauriEcDeps(): EcDeps {
  return {
    bench,
    chooseFlashrom: () =>
      open({
        title: "Choose the flashrom program",
        multiple: false,
        directory: false,
      }),
    reveal: (path) => revealItemInDir(path),
    flashromPath: flashromPathStore(window.localStorage),
  };
}
