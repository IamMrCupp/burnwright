import { describe, expect, it, vi } from "vitest";
import {
  AppearanceController,
  appearanceStore,
  parseAppearance,
  type Appearance,
  type AppearanceDeps,
  type Look,
} from "./appearance";

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

function setup(options: { stored?: Appearance; systemDark?: boolean } = {}) {
  const storage = memoryStorage();
  if (options.stored) storage.setItem("burnwright.appearance", options.stored);
  const system = fakeSystem(options.systemDark ?? false);
  const root = document.createElement("html");
  const windowThemes: (Look | null)[] = [];
  const controller = new AppearanceController({
    store: appearanceStore(storage),
    root,
    systemDark: system.query,
    setWindowTheme: (look) => void windowThemes.push(look),
  });
  return { controller, storage, system, root, windowThemes };
}

describe("parseAppearance", () => {
  it("takes the three choices and turns anything else into system", () => {
    expect(parseAppearance("light")).toBe("light");
    expect(parseAppearance("dark")).toBe("dark");
    expect(parseAppearance("system")).toBe("system");
    expect(parseAppearance("solarized")).toBe("system");
    expect(parseAppearance(null)).toBe("system");
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
    expect(controller.getState()).toBe("light");
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
    expect(controller.getState()).toBe("dark");
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
