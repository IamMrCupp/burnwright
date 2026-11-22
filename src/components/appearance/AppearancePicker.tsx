import { useSyncExternalStore } from "react";
import {
  APPEARANCES,
  parseAppearance,
  themeChoice,
  themeFile,
  type AppearanceController,
} from "../../lib/appearance";
import "./AppearancePicker.css";

const LABELS: Record<(typeof APPEARANCES)[number], string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

export interface AppearancePickerProps {
  controller: Pick<
    AppearanceController,
    "subscribe" | "getState" | "choose" | "reloadThemes" | "openThemesFolder"
  >;
}

/**
 * The Appearance choice: follow the system, hold light or dark, or use a
 * theme from the themes folder. Under it, where there is a folder: a way to
 * open it, a way to read it again, and anything a theme file got wrong.
 */
export function AppearancePicker({ controller }: AppearancePickerProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const chosen = themeFile(state.choice);
  const active = chosen === null ? undefined : state.themes.find((theme) => theme.id === chosen);

  const notes = [
    ...(state.notice ? [state.notice] : []),
    ...(active?.ignored.length
      ? [`${active.id} has entries that aren't used: ${active.ignored.join("; ")}.`]
      : []),
    ...state.broken
      // The notice has already said why this one can't be used.
      .filter(({ file }) => file !== state.noticeFile)
      .map(({ file, reason }) => `${file} isn't offered: ${reason}.`),
  ];

  return (
    <div className="appearance">
      <label className="appearance-choice">
        Appearance
        <select
          value={state.choice}
          onChange={(event) => controller.choose(parseAppearance(event.target.value))}
        >
          {APPEARANCES.map((value) => (
            <option key={value} value={value}>
              {LABELS[value]}
            </option>
          ))}
          {state.themes.length > 0 && (
            <optgroup label="Themes">
              {state.themes.map((theme) => (
                <option key={theme.id} value={themeChoice(theme.id)}>
                  {theme.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      {state.hasFolder && (
        <div className="appearance-themes">
          <button
            type="button"
            className="button-quiet"
            title={state.folder ?? undefined}
            onClick={() => void controller.openThemesFolder()}
          >
            Themes folder
          </button>
          <button
            type="button"
            className="button-quiet"
            title="Read the themes folder again"
            onClick={() => void controller.reloadThemes()}
          >
            Reload themes
          </button>
        </div>
      )}
      {notes.length > 0 && (
        <ul className="appearance-notes" role="status">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
