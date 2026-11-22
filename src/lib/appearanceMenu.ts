// The other half of View → Appearance in the macOS menu bar
// (src-tauri/src/appearance_menu.rs). The Appearance choice lives here, in
// the webview; the menu only shows it. So this sends the menu what to show
// whenever it changes, and does what a click in the menu asks for.
import { parseAppearance, type AppearanceController, type AppearanceState } from "./appearance";

/** What the menu needs to draw itself, as `set_appearance_menu` reads it. */
export interface AppearanceMenuState {
  choice: string;
  themes: { id: string; name: string }[];
  has_folder: boolean;
}

/** What a click in the menu asks for, as the `appearance-menu` event carries it. */
export type AppearanceMenuAction =
  | { action: "choose"; choice: string }
  | { action: "open_folder" }
  | { action: "reload" }
  | { action: "save" };

/** The menu bar's side of the conversation. */
export interface AppearanceMenuLink {
  /** Redraw the menu to show this. */
  show(state: AppearanceMenuState): void;
  /** Hear clicks in the menu. */
  onAction(handler: (action: AppearanceMenuAction) => void): void;
}

/** The part of the Appearance state the menu shows. */
export function menuState(state: AppearanceState): AppearanceMenuState {
  return {
    choice: state.choice,
    themes: state.themes.map(({ id, name }) => ({ id, name })),
    has_folder: state.hasFolder,
  };
}

/**
 * Keep the menu showing what the controller holds, and hand its clicks to
 * the controller: the same calls the footer's controls make.
 */
export function linkAppearanceMenu(
  controller: Pick<
    AppearanceController,
    | "subscribe"
    | "getState"
    | "choose"
    | "reloadThemes"
    | "openThemesFolder"
    | "saveLookAsTheme"
  >,
  menu: AppearanceMenuLink,
): void {
  const show = () => menu.show(menuState(controller.getState()));
  controller.subscribe(show);
  show();

  menu.onAction((action) => {
    switch (action.action) {
      case "choose":
        controller.choose(parseAppearance(action.choice));
        break;
      case "open_folder":
        void controller.openThemesFolder();
        break;
      case "reload":
        void controller.reloadThemes();
        break;
      case "save":
        void controller.saveLookAsTheme();
        break;
    }
    // A click flips the clicked item's own check mark, whatever came of it:
    // a choice that was already made, or one that couldn't be. Put the
    // marks back where the choice is.
    show();
  });
}
