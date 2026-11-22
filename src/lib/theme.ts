// Theme files: a name, the look it builds on, and the colours it changes.
// One JSON file per theme, in the `themes` folder of burnwright's config
// directory. docs/themes.md is the reference for people writing one.
//
// A theme can set colours and nothing else. Property names are checked
// against the list below and values against a strict idea of a colour, so a
// file can't reach the layout, load an image or hide a warning by accident.
import type { Look } from "./appearance";

/**
 * Every colour a theme can set: the --bw-* properties in App.css, without
 * the prefix. src/theme.test.ts keeps this list, App.css and docs/themes.md
 * in step.
 */
export const THEME_PROPERTIES = [
  "bg",
  "panel",
  "border",
  "fg",
  "muted",
  "control-bg",
  "control-border",
  "control-hover",
  "accent",
  "accent-soft",
  "danger",
  "danger-soft",
  "warning",
  "warning-soft",
  "warning-border",
  "ok",
  "ok-soft",
  "backdrop",
  "shadow",
  "hex-bg",
  "hex-header-bg",
  "hex-muted",
  "hex-edited-fg",
  "hex-edited-bg",
  "hex-selected-bg",
  "hex-cursor",
  "hex-cursor-fg",
  "hex-cursor-dim",
  "diff-changed-bg",
  "diff-changed-fg",
  "diff-extra-bg",
  "diff-extra-fg",
  "diff-missing-bg",
  "diff-missing-fg",
] as const;

export type ThemeProperty = (typeof THEME_PROPERTIES)[number];

/** A theme file that was read and can be used. */
export interface Theme {
  /** The file's name in the themes folder, `amber.json`: what the choice is stored by. */
  id: string;
  /** Shown in the Appearance choice. */
  name: string;
  /** The look every colour the theme leaves out comes from. */
  base: Look;
  colors: Partial<Record<ThemeProperty, string>>;
  /** What the file had that wasn't taken, in words, for the person who wrote it. */
  ignored: string[];
}

/** A file in the themes folder that can't be used, and why. */
export interface BrokenTheme {
  file: string;
  reason: string;
}

export type ParsedTheme = { ok: true; theme: Theme } | { ok: false; problem: BrokenTheme };

const NAME_LIMIT = 60;
const VALUE_LIMIT = 64;

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NUMBER = String.raw`(?:none|[-+]?(?:\d+\.?\d*|\.\d+)(?:%|deg|grad|rad|turn)?)`;
const SEPARATOR = String.raw`(?:\s*,\s*|\s*\/\s*|\s+)`;
const FUNCTION = new RegExp(
  String.raw`^(?:rgb|hsl)a?\(\s*${NUMBER}(?:${SEPARATOR}${NUMBER}){2,3}\s*\)$`,
  "i",
);

/**
 * Whether `value` is a colour a theme may use: hex (`#rgb`, `#rrggbb`, with
 * or without alpha), or `rgb()` / `hsl()` with plain numbers inside.
 *
 * Deliberately narrower than CSS. No names, no `var()`, no `url()`, no
 * nested functions: the properties end up in `background` and `box-shadow`
 * declarations, where a looser value could do more than colour something.
 */
export function isColor(value: unknown): value is string {
  if (typeof value !== "string" || value.length > VALUE_LIMIT) return false;
  const text = value.trim();
  if (!HEX.test(text) && !FUNCTION.test(text)) return false;
  // The browser has the last word where it can give one (`rgb(1 2, 3)`).
  if (typeof CSS !== "undefined" && typeof CSS.supports === "function") {
    return CSS.supports("color", text);
  }
  return true;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `amber.json` → `amber`. */
function stem(file: string): string {
  return file.replace(/\.json$/i, "") || file;
}

function show(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/**
 * A JSON error as the engine worded it, minus the label some engines put in
 * front: WebKit's "JSON Parse error: " and Firefox's "JSON.parse: ". The
 * sentence it goes into already says the file isn't valid JSON.
 */
function withoutEnginePrefix(detail: string): string {
  return detail.replace(/^JSON(?: Parse error|\.parse):\s*/i, "");
}

/**
 * Read one theme file. `file` is its name in the folder and `text` what it
 * holds. A file that isn't a theme comes back as a problem with a reason
 * its author can act on; a theme with entries that can't be taken comes
 * back usable, with those entries listed in `ignored`.
 */
export function parseTheme(file: string, text: string): ParsedTheme {
  const broken = (reason: string): ParsedTheme => ({ ok: false, problem: { file, reason } });

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return broken(`it isn't valid JSON (${withoutEnginePrefix(detail)})`);
  }
  if (!isObject(data)) return broken("a theme is a JSON object: { … }");

  const { name, base, colors, ...rest } = data;
  if (base !== "light" && base !== "dark") {
    return broken('"base" has to be "light" or "dark"');
  }
  if (colors !== undefined && !isObject(colors)) {
    return broken('"colors" has to be an object: { "bg": "#101418", … }');
  }

  const ignored: string[] = [];
  let shown = stem(file);
  if (typeof name === "string" && name.trim() !== "") {
    shown = name.trim().slice(0, NAME_LIMIT);
  } else if (name !== undefined) {
    ignored.push(`"name" isn't text, so the file's name is used`);
  }
  for (const key of Object.keys(rest)) {
    ignored.push(`"${key}" isn't part of a theme`);
  }

  const taken: Partial<Record<ThemeProperty, string>> = {};
  for (const [key, value] of Object.entries(colors ?? {})) {
    const property = THEME_PROPERTIES.find((known) => known === key || `--bw-${known}` === key);
    if (!property) {
      ignored.push(`"${key}" isn't a colour burnwright has`);
    } else if (!isColor(value)) {
      ignored.push(`"${key}": ${show(value)} isn't a colour a theme can use`);
    } else {
      taken[property] = value.trim();
    }
  }

  return { ok: true, theme: { id: file, name: shown, base, colors: taken, ignored } };
}

/** One file from the themes folder: its text, or why it couldn't be read. */
export interface ThemeFile {
  file: string;
  text?: string | null;
  error?: string | null;
}

/** The themes folder as the app found it. */
export interface ThemeListing {
  /** The folder's full path, to show and to open. */
  folder: string;
  files: ThemeFile[];
}

/** Where theme files come from: the config folder in the app, a pretend one in the preview. */
export interface ThemeSource {
  list(): Promise<ThemeListing>;
  /** Show the folder in the system's file manager. */
  openFolder(): Promise<void>;
}

/** Sort a listing into the themes that can be used and the files that can't. */
export function readListing(listing: ThemeListing): { themes: Theme[]; broken: BrokenTheme[] } {
  const themes: Theme[] = [];
  const broken: BrokenTheme[] = [];
  for (const { file, text, error } of listing.files) {
    if (typeof text !== "string") {
      broken.push({ file, reason: error || "it couldn't be read" });
      continue;
    }
    const parsed = parseTheme(file, text);
    if (parsed.ok) themes.push(parsed.theme);
    else broken.push(parsed.problem);
  }
  themes.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { themes, broken };
}
