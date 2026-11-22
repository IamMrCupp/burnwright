import { describe, expect, it, vi } from "vitest";
import { AppearanceController, appearanceStore, type AppearanceDeps } from "./appearance";
import {
  linkAppearanceMenu,
  type AppearanceMenuAction,
  type AppearanceMenuState,
} from "./appearanceMenu";
import type { ThemeSource } from "./theme";

function setup(themes?: ThemeSource) {
  const values = new Map<string, string>();
  const root = document.createElement("html");
  const controller = new AppearanceController({
    store: appearanceStore({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
      removeItem: (key) => void values.delete(key),
    }),
    root,
    systemDark: {
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as AppearanceDeps["systemDark"],
    themes,
    readColor: () => "#101418",
  });
  const shown: AppearanceMenuState[] = [];
  let click: (action: AppearanceMenuAction) => void = () => {};
  linkAppearanceMenu(controller, {
    show: (state) => void shown.push(state),
    onAction: (handler) => {
      click = handler;
    },
  });
  return { controller, root, shown, click: (action: AppearanceMenuAction) => click(action) };
}

function folder() {
  const files: Record<string, string> = {
    "amber.json": JSON.stringify({ name: "Amber", base: "dark", colors: { bg: "#120d02" } }),
  };
  return {
    files,
    opened: vi.fn(async () => {}),
    source(): ThemeSource {
      return {
        list: async () => ({
          folder: "/config/themes",
          files: Object.entries(files).map(([file, text]) => ({ file, text })),
        }),
        openFolder: this.opened,
        save: async (file, contents) => {
          files[file] = contents;
        },
      };
    },
  };
}

const last = (shown: AppearanceMenuState[]) => shown[shown.length - 1];

describe("linkAppearanceMenu", () => {
  it("shows the menu the choice straight away, and again when it changes", () => {
    const { controller, shown } = setup();
    expect(shown).toEqual([{ choice: "system", themes: [], has_folder: false }]);
    controller.choose("dark");
    expect(last(shown)).toEqual({ choice: "dark", themes: [], has_folder: false });
  });

  it("shows the themes once the folder has been read", async () => {
    const { controller, shown } = setup(folder().source());
    await controller.reloadThemes();
    expect(last(shown)).toEqual({
      choice: "system",
      themes: [{ id: "amber.json", name: "Amber" }],
      has_folder: true,
    });
  });

  it("makes a clicked look or theme the choice", async () => {
    const { controller, root, shown, click } = setup(folder().source());
    await controller.reloadThemes();

    click({ action: "choose", choice: "light" });
    expect(controller.getState().choice).toBe("light");
    expect(root.dataset.theme).toBe("light");

    click({ action: "choose", choice: "theme:amber.json" });
    expect(controller.getState().choice).toBe("theme:amber.json");
    expect(root.style.getPropertyValue("--bw-bg")).toBe("#120d02");
    expect(last(shown).choice).toBe("theme:amber.json");
  });

  it("shows the menu the choice again after a click that changed nothing", async () => {
    const { controller, shown, click } = setup(folder().source());
    await controller.reloadThemes();
    controller.choose("dark");

    // The look that's already chosen: the click still unticked it in the menu.
    let before = shown.length;
    click({ action: "choose", choice: "dark" });
    expect(shown.length).toBeGreaterThan(before);
    expect(last(shown).choice).toBe("dark");

    // A theme that isn't there, and something that isn't a choice at all.
    before = shown.length;
    click({ action: "choose", choice: "theme:gone.json" });
    click({ action: "choose", choice: "sepia" });
    expect(shown.length).toBeGreaterThan(before);
    // "sepia" reads as System, the way a stored value it doesn't know does.
    expect(controller.getState().choice).toBe("system");
    expect(last(shown).choice).toBe("system");
  });

  it("runs the folder's three commands", async () => {
    const themes = folder();
    const { controller, shown, click } = setup(themes.source());
    await controller.reloadThemes();

    click({ action: "open_folder" });
    expect(themes.opened).toHaveBeenCalledTimes(1);

    themes.files["new.json"] = JSON.stringify({ name: "New", base: "light" });
    click({ action: "reload" });
    await vi.waitFor(() =>
      expect(last(shown).themes.map((theme) => theme.name)).toEqual(["Amber", "New"]),
    );

    click({ action: "save" });
    await vi.waitFor(() => expect(controller.getState().saved).toBe("my-theme.json"));
    expect(last(shown).themes.map((theme) => theme.id)).toContain("my-theme.json");
  });
});
