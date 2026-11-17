// The device screen's dependencies in the real app: the Tauri engine, the
// system's file panels and the webview's localStorage.
import { open, save } from "@tauri-apps/plugin-dialog";
import { engine } from "../engine";
import type { DeviceDeps, FileDialogs } from "./controller";
import { recentStore } from "./recent";

/**
 * The extensions offered first. `engine.loadImage` goes by what a file
 * holds, not only its name: Intel HEX is decoded whatever it's called.
 */
const IMAGE_FILTERS = [
  { name: "Chip images", extensions: ["bin", "rom", "hex", "ihx", "ihex", "h86"] },
  { name: "All files", extensions: ["*"] },
];

const dialogs: FileDialogs = {
  open: () =>
    open({
      title: "Open an image",
      multiple: false,
      directory: false,
      filters: IMAGE_FILTERS,
    }),
  save: (suggested) =>
    save({
      title: "Save the buffer",
      defaultPath: suggested,
      filters: [
        { name: "Raw binary", extensions: ["bin"] },
        { name: "Intel HEX", extensions: ["hex"] },
      ],
    }),
};

export function tauriDeps(): DeviceDeps {
  return { engine, dialogs, recent: recentStore(window.localStorage) };
}
