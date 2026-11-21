// The device screen's dependencies in the real app: the Tauri engine, the
// system's file panels, the webview's localStorage and the app's window.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, type Theme } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { engine } from "../engine";
import type { ThemeListing, ThemeSource } from "../theme";
import type { DeviceController, DeviceDeps, FileDialogs } from "./controller";
import { recentStore } from "./recent";
import { settingsStore } from "./settings";

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
  openAlgorithms: () =>
    open({
      title: "Choose your algorithm.xml",
      multiple: false,
      directory: false,
      filters: [
        { name: "Algorithm file", extensions: ["xml"] },
        { name: "All files", extensions: ["*"] },
      ],
    }),
};

export function tauriDeps(): DeviceDeps {
  return {
    engine,
    dialogs,
    recent: recentStore(window.localStorage),
    settings: settingsStore(window.localStorage),
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

/**
 * Give the window's title bar and native menus the chosen look; `null`
 * hands them back to the system. The page has its look either way, so a
 * platform that can't do this just keeps its own title bar.
 */
export function setWindowTheme(theme: Theme | null): void {
  void getCurrentWindow()
    .setTheme(theme)
    .catch(() => {});
}

/** The themes folder in burnwright's config directory (src-tauri/src/themes.rs). */
export function tauriThemes(): ThemeSource {
  return {
    list: () => invoke<ThemeListing>("list_themes"),
    openFolder: () => invoke<void>("open_themes_folder"),
  };
}
