import { useSyncExternalStore } from "react";
import {
  APPEARANCES,
  parseAppearance,
  type Appearance,
  type AppearanceController,
} from "../../lib/appearance";
import "./AppearancePicker.css";

const LABELS: Record<Appearance, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

export interface AppearancePickerProps {
  controller: Pick<AppearanceController, "subscribe" | "getState" | "choose">;
}

/** The Appearance choice: follow the system, or hold light or dark. */
export function AppearancePicker({ controller }: AppearancePickerProps) {
  const choice = useSyncExternalStore(controller.subscribe, controller.getState);
  return (
    <label className="appearance">
      Appearance
      <select
        value={choice}
        onChange={(event) => controller.choose(parseAppearance(event.target.value))}
      >
        {APPEARANCES.map((value) => (
          <option key={value} value={value}>
            {LABELS[value]}
          </option>
        ))}
      </select>
    </label>
  );
}
