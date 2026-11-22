// The Appearance choice: follow the system, hold the light or the dark
// look whatever the system says, or use a theme from the themes folder.
//
// A look is a set of values for the --bw-* properties in App.css;
// `data-theme` on the root element picks it. A theme is a look plus the
// colours it changes, set as inline properties on the same element.
import {
  THEME_PROPERTIES,
  parseTheme,
  readListing,
  type BrokenTheme,
  type Theme,
  type ThemeSource,
} from "./theme";

/** One of the two looks App.css defines. */
export type Look = "light" | "dark";

/** A theme file as a choice: `theme:` and the file's name. */
export type ThemeChoice = `theme:${string}`;

/** What the user picked. `system` follows the OS setting, live. */
export type Appearance = "system" | Look | ThemeChoice;

/** The built-in choices, in the order they're offered. */
export const APPEARANCES: readonly ("system" | Look)[] = ["system", "light", "dark"];

const THEME_PREFIX = "theme:";

/** The choice that picks the theme in `file`. */
export function themeChoice(file: string): ThemeChoice {
  return `${THEME_PREFIX}${file}`;
}

/** The theme file a choice names, or `null` for a built-in choice. */
export function themeFile(choice: Appearance): string | null {
  return choice.startsWith(THEME_PREFIX) ? choice.slice(THEME_PREFIX.length) : null;
}

/** `value` as a choice; anything that isn't one is `system`. */
export function parseAppearance(value: unknown): Appearance {
  const builtIn = APPEARANCES.find((choice) => choice === value);
  if (builtIn) return builtIn;
  if (typeof value === "string" && value.startsWith(THEME_PREFIX)) {
    const file = value.slice(THEME_PREFIX.length);
    if (file !== "") return themeChoice(file);
  }
  return "system";
}

/** Where the choice is kept between runs. */
export interface AppearanceStore {
  load(): Appearance;
  save(choice: Appearance): void;
  /**
   * The chosen theme as it was last read from its file, so the next start
   * can show it before the themes folder has been read again.
   */
  loadTheme(): Theme | null;
  saveTheme(theme: Theme | null): void;
}

const APPEARANCE_KEY = "burnwright.appearance";
const THEME_KEY = "burnwright.appearance.theme";

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
    loadTheme() {
      try {
        const kept = JSON.parse(storage.getItem(THEME_KEY) ?? "null") as unknown;
        if (typeof kept !== "object" || kept === null) return null;
        const { id, ...file } = kept as { id?: unknown };
        if (typeof id !== "string" || id === "") return null;
        // Through the same checks as a file: what's kept is no more trusted.
        const parsed = parseTheme(id, JSON.stringify(file));
        return parsed.ok ? parsed.theme : null;
      } catch {
        return null;
      }
    },
    saveTheme(theme) {
      try {
        if (theme === null) storage.removeItem(THEME_KEY);
        else {
          const { id, name, base, colors } = theme;
          storage.setItem(THEME_KEY, JSON.stringify({ id, name, base, colors }));
        }
      } catch {
        // As above.
      }
    },
  };
}

/** What the controller needs from the page and the window. */
export interface AppearanceDeps {
  store: AppearanceStore;
  /** The element `data-theme` and a theme's colours go on: the document's root. */
  root: HTMLElement;
  /** `matchMedia("(prefers-color-scheme: dark)")`: the system's setting. */
  systemDark: Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener">;
  /**
   * Give the window's own chrome (title bar, native menus) a look; `null`
   * hands it back to the system. Left out where there is no window to tell.
   */
  setWindowTheme?: (look: Look | null) => void;
  /** The themes folder. Left out where there isn't one: no themes are offered. */
  themes?: ThemeSource;
}

/** Everything the Appearance choice shows. */
export interface AppearanceState {
  choice: Appearance;
  /** The themes found in the folder, by name. */
  themes: readonly Theme[];
  /** Files in the folder that can't be used, and why. */
  broken: readonly BrokenTheme[];
  /** Whether there is a themes folder at all. */
  hasFolder: boolean;
  /** Where it is, once it has been read. */
  folder: string | null;
  /** Something to tell the user: a theme that went away, a folder that couldn't be read. */
  notice: string | null;
  /**
   * The theme file the notice is about, when it's about one. The notice has
   * already said why that file can't be used, so it isn't listed again with
   * the other broken files.
   */
  noticeFile: string | null;
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "it didn't say why";
}

/**
 * Holds the Appearance choice and keeps the page showing it. `start` puts
 * the stored choice on the page and reads the themes folder; `choose`
 * changes the choice. Read it from React with
 * `useSyncExternalStore(controller.subscribe, controller.getState)`.
 */
export class AppearanceController {
  private state: AppearanceState;
  /** The theme on the page, when the choice is one. */
  private active: Theme | null = null;
  /** Counts folder reads, so a slow one can't overwrite a later one. */
  private reads = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: AppearanceDeps) {
    const choice = deps.store.load();
    const file = themeFile(choice);
    if (file !== null && deps.themes) {
      const kept = deps.store.loadTheme();
      if (kept?.id === file) this.active = kept;
    }
    this.state = {
      // A theme with no folder to find it in can't be shown or changed.
      choice: file !== null && !deps.themes ? "system" : choice,
      themes: this.active ? [this.active] : [],
      broken: [],
      hasFolder: deps.themes !== undefined,
      folder: null,
      notice: null,
      noticeFile: null,
    };
  }

  getState = (): AppearanceState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The look on the page now: the chosen one, the theme's base, or the system's. */
  look(): Look {
    const { choice } = this.state;
    if (choice === "light" || choice === "dark") return choice;
    if (this.active) return this.active.base;
    return this.deps.systemDark.matches ? "dark" : "light";
  }

  /**
   * Show the stored choice, read the themes folder, and keep up with the
   * system while the choice is `system`. Returns a function that stops
   * following it.
   */
  start(): () => void {
    // Telling the window can itself change what the page sees as the
    // system's setting; this listener is what settles it afterwards.
    const onSystemChange = () => this.paint();
    this.deps.systemDark.addEventListener("change", onSystemChange);
    this.show();
    void this.reloadThemes();
    return () => this.deps.systemDark.removeEventListener("change", onSystemChange);
  }

  choose = (choice: Appearance): void => {
    if (choice === this.state.choice) return;
    const file = themeFile(choice);
    const theme = file === null ? null : this.state.themes.find((found) => found.id === file);
    // A theme that isn't in the folder can't be chosen.
    if (theme === undefined) return;
    this.active = theme;
    this.deps.store.save(choice);
    this.deps.store.saveTheme(theme);
    this.update({ choice, notice: null, noticeFile: null });
    this.show();
  };

  /**
   * Read the themes folder again: new files appear, edited ones are
   * re-applied. A chosen theme that has gone, or can no longer be read,
   * gives way to `system`, with a notice saying which and why.
   */
  reloadThemes = async (): Promise<void> => {
    const source = this.deps.themes;
    if (!source) return;
    const read = ++this.reads;
    let listing;
    try {
      listing = await source.list();
    } catch (error) {
      if (read !== this.reads) return;
      // Whatever is on the page stays there.
      this.update({
        notice: `The themes folder couldn't be read: ${message(error)}`,
        noticeFile: null,
      });
      return;
    }
    if (read !== this.reads) return;

    const { themes, broken } = readListing(listing);
    let { choice } = this.state;
    let notice: string | null = null;
    let noticeFile: string | null = null;
    const file = themeFile(choice);
    if (file !== null) {
      const found = themes.find((theme) => theme.id === file);
      if (found) {
        this.active = found;
        this.deps.store.saveTheme(found);
      } else {
        const why = broken.find((problem) => problem.file === file);
        notice = why
          ? `${file} can't be used as a theme any more: ${why.reason}. Appearance is back on System.`
          : `${file} isn't in the themes folder any more. Appearance is back on System.`;
        noticeFile = file;
        choice = "system";
        this.active = null;
        this.deps.store.save(choice);
        this.deps.store.saveTheme(null);
      }
    }
    this.update({ choice, themes, broken, folder: listing.folder, notice, noticeFile });
    this.show();
  };

  /** Show the themes folder in the system's file manager. */
  openThemesFolder = async (): Promise<void> => {
    const source = this.deps.themes;
    if (!source) return;
    try {
      await source.openFolder();
    } catch (error) {
      const where = this.state.folder ? ` It's at ${this.state.folder}.` : "";
      this.update({
        notice: `The themes folder couldn't be opened: ${message(error)}.${where}`,
        noticeFile: null,
      });
    }
  };

  private update(change: Partial<AppearanceState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  /** Put the choice on the page and on the window. */
  private show(): void {
    this.paint();
    const { choice } = this.state;
    const held = choice === "light" || choice === "dark" ? choice : (this.active?.base ?? null);
    this.deps.setWindowTheme?.(held);
  }

  private paint(): void {
    const { root } = this.deps;
    root.dataset.theme = this.look();
    for (const property of THEME_PROPERTIES) root.style.removeProperty(`--bw-${property}`);
    for (const [property, value] of Object.entries(this.active?.colors ?? {})) {
      root.style.setProperty(`--bw-${property}`, value);
    }
  }
}
