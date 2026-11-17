// The device screen's dependencies in the real app: the Tauri engine, the
// system's file panels, the webview's localStorage and the app's window.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { engine } from "../engine";
import type { DeviceController, DeviceDeps, FileDialogs } from "./controller";
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
  return {
    engine,
    dialogs,
    recent: recentStore(window.localStorage),
    // `destroy`, not `close`: a close would come straight back as a request.
    closeWindow: () => {
      void getCurrentWindow()
        .destroy()
        .catch(() => {});
    },
  };
}

/**
 * Put every request to close the window to the controller first: the title
 * bar's close button, Alt+F4, and on macOS Cmd+Q and the Quit menu item,
 * which the app sends this way (`request_close` in src-tauri/src/lib.rs).
 * The controller either lets the window go or keeps it and asks.
 */
export function guardWindowClose(controller: Pick<DeviceController, "requestClose">): void {
  void getCurrentWindow().onCloseRequested((event) => {
    if (!controller.requestClose()) event.preventDefault();
  });
}
