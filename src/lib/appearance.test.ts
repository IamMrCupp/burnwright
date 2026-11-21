import { describe, expect, it, vi } from "vitest";
import {
  AppearanceController,
  appearanceStore,
  parseAppearance,
  type Appearance,
  type AppearanceDeps,
  type Look,
} from "./appearance";
import type { ThemeListing, ThemeSource } from "./theme";

function memoryStorage() {
  const stored = new Map<string, string>();
  return {
    stored,
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  };
}

/** A stand-in for `matchMedia("(prefers-color-scheme: dark)")`. */
function fakeSystem(dark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: dark,
    addEventListener: (_type: string, listener: () => void) => void listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => void listeners.delete(listener),
  };
  return {
    query: query as unknown as AppearanceDeps["systemDark"],
    listeners,
    /** The OS setting changes. */
    set(nowDark: boolean) {
      query.matches = nowDark;
      for (const listener of [...listeners]) listener();
    },
  };
}

const AMBER = { name: "Amber", base: "dark", colors: { bg: "#120d02", accent: "#ffb000" } };
const PAPER = { name: "Paper", base: "light", colors: { bg: "#f4efe4" } };

/** A themes folder whose files the test can change between reads. */
function fakeFolder(files: Record<string, unknown> = { "amber.json": AMBER, "paper.json": PAPER }) {
  const folder = {
    files,
    /** Set to make the next reads fail. */
    failure: null as string | null,
    opened: 0,
    source: {
      list: async (): Promise<ThemeListing> => {
        if (folder.failure) throw new Error(folder.failure);
        return {
          folder: "/config/themes",
          files: Object.entries(folder.files).map(([file, value]) => ({
            file,
            text: typeof value === "string" ? value : JSON.stringify(value),
          })),
        };
      },
      openFolder: async () => {
        if (folder.failure) throw new Error(folder.failure);
        folder.opened += 1;
      },
    } satisfies ThemeSource,
  };
  return folder;
}

function setup(
  options: {
    stored?: Appearance;
    systemDark?: boolean;
    folder?: ReturnType<typeof fakeFolder>;
    storage?: ReturnType<typeof memoryStorage>;
  } = {},
) {
  const storage = options.storage ?? memoryStorage();
  if (options.stored) storage.setItem("burnwright.appearance", options.stored);
  const system = fakeSystem(options.systemDark ?? false);
  const root = document.createElement("html");
  const windowThemes: (Look | null)[] = [];
  const controller = new AppearanceController({
    store: appearanceStore(storage),
    root,
    systemDark: system.query,
    setWindowTheme: (look) => void windowThemes.push(look),
    themes: options.folder?.source,
  });
  return { controller, storage, system, root, windowThemes };
}

/** The --bw-* properties set on the element itself, as a theme sets them. */
function inline(root: HTMLElement): Record<string, string> {
  return Object.fromEntries(
    Array.from(root.style).map((name) => [name, root.style.getPropertyValue(name)]),
  );
}

describe("parseAppearance", () => {
  it("takes the three choices and turns anything else into system", () => {
    expect(parseAppearance("light")).toBe("light");
    expect(parseAppearance("dark")).toBe("dark");
    expect(parseAppearance("system")).toBe("system");
    expect(parseAppearance("solarized")).toBe("system");
    expect(parseAppearance(null)).toBe("system");
  });

  it("takes a theme file as a choice", () => {
    expect(parseAppearance("theme:amber.json")).toBe("theme:amber.json");
    expect(parseAppearance("theme:")).toBe("system");
  });
});

describe("appearanceStore", () => {
  it("is system until a look is chosen, and remembers the look", () => {
    const storage = memoryStorage();
    const store = appearanceStore(storage);
    expect(store.load()).toBe("system");
    store.save("dark");
    expect(appearanceStore(storage).load()).toBe("dark");
    // Back to the default leaves nothing behind.
    store.save("system");
    expect(storage.stored.size).toBe(0);
  });

  it("reads a value it doesn't know as system", () => {
    const storage = memoryStorage();
    storage.setItem("burnwright.appearance", "sepia");
    expect(appearanceStore(storage).load()).toBe("system");
  });

  it("carries on when the storage throws", () => {
    const store = appearanceStore({
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    });
    expect(store.load()).toBe("system");
    expect(() => store.save("dark")).not.toThrow();
    expect(() => store.save("system")).not.toThrow();
  });
});

describe("appearanceStore's kept theme", () => {
  const amber = {
    id: "amber.json",
    name: "Amber",
    base: "dark" as const,
    colors: { bg: "#120d02" },
    ignored: [],
  };

  it("keeps the chosen theme and gives it back", () => {
    const storage = memoryStorage();
    const store = appearanceStore(storage);
    expect(store.loadTheme()).toBeNull();
    store.saveTheme(amber);
    expect(appearanceStore(storage).loadTheme()).toEqual(amber);
    store.saveTheme(null);
    expect(store.loadTheme()).toBeNull();
  });

  it("puts what it kept through the same checks as a file", () => {
    const storage = memoryStorage();
    storage.setItem(
      "burnwright.appearance.theme",
      JSON.stringify({ ...amber, colors: { bg: "url(https://example.com/x.png)", fg: "#fff" } }),
    );
    expect(appearanceStore(storage).loadTheme()?.colors).toEqual({ fg: "#fff" });

    for (const junk of ["{", "7", '{"name":"No id","base":"dark"}', '{"id":"x.json"}']) {
      storage.setItem("burnwright.appearance.theme", junk);
      expect(appearanceStore(storage).loadTheme(), junk).toBeNull();
    }
  });
});

describe("AppearanceController", () => {
  it("starts on the system's look and leaves the window to the system", () => {
    const light = setup({ systemDark: false });
    light.controller.start();
    expect(light.root.dataset.theme).toBe("light");
    expect(light.windowThemes).toEqual([null]);

    const dark = setup({ systemDark: true });
    dark.controller.start();
    expect(dark.root.dataset.theme).toBe("dark");
  });

  it("follows the system while the choice is system", () => {
    const { controller, system, root } = setup({ systemDark: false });
    controller.start();
    system.set(true);
    expect(root.dataset.theme).toBe("dark");
    system.set(false);
    expect(root.dataset.theme).toBe("light");
  });

  it("starts on a stored look whatever the system says", () => {
    const { controller, root, windowThemes } = setup({ stored: "light", systemDark: true });
    controller.start();
    expect(controller.getState().choice).toBe("light");
    expect(root.dataset.theme).toBe("light");
    expect(windowThemes).toEqual(["light"]);
  });

  it("holds a chosen look when the system changes", () => {
    const { controller, system, root } = setup({ systemDark: false });
    controller.start();
    controller.choose("dark");
    expect(root.dataset.theme).toBe("dark");
    system.set(true);
    system.set(false);
    expect(root.dataset.theme).toBe("dark");
  });

  it("keeps the choice, tells the window and tells its subscribers", () => {
    const { controller, storage, windowThemes } = setup();
    controller.start();
    const heard = vi.fn();
    const unsubscribe = controller.subscribe(heard);

    controller.choose("dark");
    expect(controller.getState().choice).toBe("dark");
    expect(storage.stored.get("burnwright.appearance")).toBe("dark");
    expect(windowThemes).toEqual([null, "dark"]);
    expect(heard).toHaveBeenCalledTimes(1);

    // The same choice again is not a change.
    controller.choose("dark");
    expect(heard).toHaveBeenCalledTimes(1);
    expect(windowThemes).toEqual([null, "dark"]);

    unsubscribe();
    controller.choose("light");
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("goes back to the system's look, and hands the window back, on system", () => {
    const { controller, system, root, windowThemes } = setup({ stored: "dark", systemDark: false });
    controller.start();
    expect(root.dataset.theme).toBe("dark");
    controller.choose("system");
    expect(root.dataset.theme).toBe("light");
    expect(windowThemes).toEqual(["dark", null]);
    system.set(true);
    expect(root.dataset.theme).toBe("dark");
  });

  it("stops following the system when stopped", () => {
    const { controller, system, root } = setup({ systemDark: false });
    const stop = controller.start();
    expect(system.listeners.size).toBe(1);
    stop();
    expect(system.listeners.size).toBe(0);
    system.set(true);
    expect(root.dataset.theme).toBe("light");
  });

  it("works with no window to tell", () => {
    const root = document.createElement("html");
    const controller = new AppearanceController({
      store: appearanceStore(memoryStorage()),
      root,
      systemDark: fakeSystem(true).query,
    });
    controller.start();
    controller.choose("light");
    expect(root.dataset.theme).toBe("light");
  });
});

describe("AppearanceController with a themes folder", () => {
  it("offers the themes it finds, and nothing where there's no folder", async () => {
    const none = setup();
    none.controller.start();
    await none.controller.reloadThemes();
    expect(none.controller.getState()).toMatchObject({ hasFolder: false, themes: [] });

    const { controller } = setup({ folder: fakeFolder() });
    await controller.reloadThemes();
    expect(controller.getState()).toMatchObject({
      hasFolder: true,
      folder: "/config/themes",
      broken: [],
      notice: null,
    });
    expect(controller.getState().themes.map((theme) => theme.name)).toEqual(["Amber", "Paper"]);
  });

  it("puts a chosen theme's base and colours on the page, and takes them off again", async () => {
    const { controller, root, storage, windowThemes } = setup({ folder: fakeFolder() });
    controller.start();
    await controller.reloadThemes();

    controller.choose("theme:amber.json");
    expect(controller.getState().choice).toBe("theme:amber.json");
    expect(root.dataset.theme).toBe("dark");
    expect(inline(root)).toEqual({ "--bw-bg": "#120d02", "--bw-accent": "#ffb000" });
    expect(windowThemes[windowThemes.length - 1]).toBe("dark");
    expect(storage.stored.get("burnwright.appearance")).toBe("theme:amber.json");

    // Another theme: nothing of the first one is left behind.
    controller.choose("theme:paper.json");
    expect(root.dataset.theme).toBe("light");
    expect(inline(root)).toEqual({ "--bw-bg": "#f4efe4" });

    controller.choose("dark");
    expect(inline(root)).toEqual({});
    expect(storage.stored.has("burnwright.appearance.theme")).toBe(false);
  });

  it("won't choose a theme that isn't in the folder", async () => {
    const { controller, root } = setup({ folder: fakeFolder() });
    controller.start();
    await controller.reloadThemes();
    controller.choose("theme:missing.json");
    expect(controller.getState().choice).toBe("system");
    expect(inline(root)).toEqual({});
  });

  it("shows the kept theme at the next start, before the folder has been read", async () => {
    const storage = memoryStorage();
    const folder = fakeFolder();
    const first = setup({ folder, storage });
    first.controller.start();
    await first.controller.reloadThemes();
    first.controller.choose("theme:amber.json");

    const next = setup({ folder, storage, systemDark: false });
    next.controller.start();
    // No await: this is the first frame.
    expect(next.root.dataset.theme).toBe("dark");
    expect(inline(next.root)).toEqual({ "--bw-bg": "#120d02", "--bw-accent": "#ffb000" });
    expect(next.controller.getState().choice).toBe("theme:amber.json");
  });

  it("picks up an edited file on reload", async () => {
    const folder = fakeFolder();
    const { controller, root } = setup({ folder });
    controller.start();
    await controller.reloadThemes();
    controller.choose("theme:amber.json");

    folder.files["amber.json"] = { ...AMBER, base: "light", colors: { bg: "#fff8e0" } };
    folder.files["new.json"] = { name: "New", base: "dark" };
    await controller.reloadThemes();
    expect(root.dataset.theme).toBe("light");
    expect(inline(root)).toEqual({ "--bw-bg": "#fff8e0" });
    expect(controller.getState().themes.map((theme) => theme.name)).toEqual([
      "Amber",
      "New",
      "Paper",
    ]);
  });

  it("goes back to System, and says why, when the chosen theme has gone", async () => {
    const folder = fakeFolder();
    const { controller, root, storage, windowThemes } = setup({ folder, systemDark: false });
    controller.start();
    await controller.reloadThemes();
    controller.choose("theme:amber.json");

    delete folder.files["amber.json"];
    await controller.reloadThemes();
    expect(controller.getState().choice).toBe("system");
    expect(controller.getState().notice).toBe(
      "amber.json isn't in the themes folder any more. Appearance is back on System.",
    );
    expect(root.dataset.theme).toBe("light");
    expect(inline(root)).toEqual({});
    expect(windowThemes[windowThemes.length - 1]).toBeNull();
    expect(storage.stored.size).toBe(0);

    // Choosing something clears the notice.
    controller.choose("dark");
    expect(controller.getState().notice).toBeNull();
  });

  it("goes back to System when the chosen theme's file breaks, with the reason", async () => {
    const folder = fakeFolder();
    const { controller } = setup({ folder });
    controller.start();
    await controller.reloadThemes();
    controller.choose("theme:amber.json");

    folder.files["amber.json"] = "{ not json";
    await controller.reloadThemes();
    const state = controller.getState();
    expect(state.choice).toBe("system");
    expect(state.notice).toMatch(
      /^amber\.json can't be used as a theme any more: it isn't valid JSON .* Appearance is back on System\.$/,
    );
    expect(state.broken.map((problem) => problem.file)).toEqual(["amber.json"]);
  });

  it("keeps what's on the page when the folder can't be read", async () => {
    const folder = fakeFolder();
    const { controller, root } = setup({ folder });
    controller.start();
    await controller.reloadThemes();
    controller.choose("theme:amber.json");

    folder.failure = "permission denied";
    await controller.reloadThemes();
    const state = controller.getState();
    expect(state.notice).toBe("The themes folder couldn't be read: permission denied");
    expect(state.choice).toBe("theme:amber.json");
    expect(root.dataset.theme).toBe("dark");
    expect(state.themes).toHaveLength(2);
  });

  it("lets a later read win over an earlier one that's slower", async () => {
    const folder = fakeFolder();
    const { controller } = setup({ folder });
    let release: (listing: ThemeListing) => void = () => {};
    const slow = new Promise<ThemeListing>((resolve) => (release = resolve));
    const quick = folder.source.list;
    folder.source.list = () => slow;
    const first = controller.reloadThemes();
    folder.source.list = quick;
    await controller.reloadThemes();
    release({ folder: "/old", files: [] });
    await first;
    expect(controller.getState().folder).toBe("/config/themes");
    expect(controller.getState().themes).toHaveLength(2);
  });

  it("opens the folder, and says where it is when that fails", async () => {
    const folder = fakeFolder();
    const { controller } = setup({ folder });
    await controller.reloadThemes();
    await controller.openThemesFolder();
    expect(folder.opened).toBe(1);

    folder.failure = "no file manager";
    await controller.openThemesFolder();
    expect(controller.getState().notice).toBe(
      "The themes folder couldn't be opened: no file manager. It's at /config/themes.",
    );
  });

  it("treats a stored theme as System where there's no folder, without forgetting it", () => {
    const { controller, root, storage } = setup({ stored: "theme:amber.json", systemDark: true });
    controller.start();
    expect(controller.getState().choice).toBe("system");
    expect(root.dataset.theme).toBe("dark");
    expect(storage.stored.get("burnwright.appearance")).toBe("theme:amber.json");
  });
});
