// The Appearance choice: follow the system, or hold the light or the dark
// look whatever the system says. A look is a set of values for the --bw-*
// properties in App.css; `data-theme` on the root element picks it.

/** One of the two looks App.css defines. */
export type Look = "light" | "dark";

/** What the user picked. `system` follows the OS setting, live. */
export type Appearance = "system" | Look;

/** The choices, in the order they're offered. */
export const APPEARANCES: readonly Appearance[] = ["system", "light", "dark"];

/** `value` as a choice; anything that isn't one is `system`. */
export function parseAppearance(value: unknown): Appearance {
  return APPEARANCES.find((choice) => choice === value) ?? "system";
}

/** Where the choice is kept between runs. */
export interface AppearanceStore {
  load(): Appearance;
  save(choice: Appearance): void;
}

const APPEARANCE_KEY = "burnwright.appearance";

/**
 * A store over `storage` (the browser's `localStorage`). `system` is the
 * default, so it's stored as nothing at all. A storage that throws just
 * means the choice lasts until the app closes.
 */
export function appearanceStore(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
): AppearanceStore {
  return {
    load() {
      try {
        return parseAppearance(storage.getItem(APPEARANCE_KEY));
      } catch {
        return "system";
      }
    },
    save(choice) {
      try {
        if (choice === "system") storage.removeItem(APPEARANCE_KEY);
        else storage.setItem(APPEARANCE_KEY, choice);
      } catch {
        // Not worth interrupting anyone for.
      }
    },
  };
}

/** What the controller needs from the page and the window. */
export interface AppearanceDeps {
  store: AppearanceStore;
  /** The element `data-theme` goes on: the document's root. */
  root: HTMLElement;
  /** `matchMedia("(prefers-color-scheme: dark)")`: the system's setting. */
  systemDark: Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener">;
  /**
   * Give the window's own chrome (title bar, native menus) a look; `null`
   * hands it back to the system. Left out where there is no window to tell.
   */
  setWindowTheme?: (look: Look | null) => void;
}

/**
 * Holds the Appearance choice and keeps the page showing it. `start` puts
 * the stored choice on the page; `choose` changes it. Read it from React
 * with `useSyncExternalStore(controller.subscribe, controller.getState)`.
 */
export class AppearanceController {
  private choice: Appearance;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: AppearanceDeps) {
    this.choice = deps.store.load();
  }

  getState = (): Appearance => this.choice;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The look on the page now: the chosen one, or the system's. */
  look(): Look {
    if (this.choice !== "system") return this.choice;
    return this.deps.systemDark.matches ? "dark" : "light";
  }

  /**
   * Show the stored choice, and keep up with the system while the choice is
   * `system`. Returns a function that stops following it.
   */
  start(): () => void {
    // Telling the window can itself change what the page sees as the
    // system's setting; this listener is what settles it afterwards.
    const onSystemChange = () => this.paint();
    this.deps.systemDark.addEventListener("change", onSystemChange);
    this.paint();
    this.deps.setWindowTheme?.(this.windowTheme());
    return () => this.deps.systemDark.removeEventListener("change", onSystemChange);
  }

  choose = (choice: Appearance): void => {
    if (choice === this.choice) return;
    this.choice = choice;
    this.deps.store.save(choice);
    this.paint();
    this.deps.setWindowTheme?.(this.windowTheme());
    for (const listener of this.listeners) listener();
  };

  private windowTheme(): Look | null {
    return this.choice === "system" ? null : this.choice;
  }

  private paint(): void {
    this.deps.root.dataset.theme = this.look();
  }
}
