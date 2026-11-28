// Hides file paths in what a screen draws, for when the window is being
// captured for a live stream. A path names a home folder at least and a
// customer at worst, and paths turn up all over: the log's "Opened …" and
// command lines, the buffer's file name, the algorithm file, the EC bench's
// flashrom and backup lines.
//
// It works on a screen's whole state, not at each place a path is printed:
// every string in the state goes through `maskPaths`, so a path that turns
// up somewhere new is covered without anyone remembering to. The state the
// controller holds is never touched. Opening, saving and the operations run
// on the real paths; only the copy that's drawn is masked.

/** What a path reads as. Its extension is kept: `[hidden].bin`. */
export const HIDDEN = "[hidden]";

// A path starts with `/`, `~/`, `\\server\` or a drive letter, at the start
// of a word: the slash in "PIC18F67K22-I/PT", "and/or" or "https://…" has
// something before it and isn't one. It runs to the next space or quote.
// The character before is captured, not looked behind at: older WebKitGTK
// has no lookbehind, and a pattern it can't parse would stop the app.
const PATH =
  /(^|[^\w@./\\:~+-])((?:~[\\/]|\\\\|[A-Za-z]:[\\/]|\/(?=[^\s/]))[^\s"'`<>|]*)/g;

/** Punctuation a sentence puts after a path, not part of it. */
const TRAILING = /[.,:;!?)\]]+$/;

/** How a path starts. */
const PATH_START = /^(?:~[\\/]|\\\\|[A-Za-z]:[\\/]|\/)/;

/**
 * The names state gives a field that holds a path and nothing else:
 * `path`, `default_path`, `flashromChosen`, and the algorithm file's
 * `configured` and `found`. A string is only taken for a whole path under
 * one of these. Going by its looks alone would take a command line that
 * starts with a program's path for one long path, and hide all of it.
 */
const PATH_KEY = /(?:path|chosen)$|^(?:configured|found)$/i;

/** The folder a path is in, or `null` at the top. */
function parent(path: string): string | null {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : null;
}

/** `[hidden]`, with the path's extension if it has a plain one. */
function hidden(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(name);
  return ext && ext.index > 0 ? `${HIDDEN}${ext[0]}` : HIDDEN;
}

/** What can follow a known path and still be part of it: the same run `PATH` takes. */
const PATH_REST = /^[^\s"'`<>|]*/;

/**
 * `text` with every `path` in it hidden, along with whatever runs on from
 * it: a known folder is usually the start of a longer path. Hiding just the
 * folder would leave `[hidden]/bin/minipro`, and the rest would then be
 * hidden again as a path of its own: `[hidden][hidden]`.
 */
function hideKnown(text: string, path: string): string {
  let out = "";
  let from = 0;
  for (let at = text.indexOf(path); at !== -1; at = text.indexOf(path, from)) {
    const rest = PATH_REST.exec(text.slice(at + path.length))?.[0] ?? "";
    const tail = TRAILING.exec(rest)?.[0] ?? "";
    const end = at + path.length + rest.length - tail.length;
    out += text.slice(from, at) + hidden(text.slice(at, end));
    from = end;
  }
  return out + text.slice(from);
}

/**
 * `text` with every path in it hidden. `known` are paths to hide wherever
 * they appear whole: that's what catches one with a space in it, which
 * nothing in the text marks the end of.
 */
export function maskPaths(text: string, known: readonly string[] = []): string {
  let masked = text;
  for (const path of known) {
    if (path !== "" && masked.includes(path)) masked = hideKnown(masked, path);
  }
  return masked.replace(PATH, (_match, before: string, found: string) => {
    const tail = TRAILING.exec(found)?.[0] ?? "";
    const path = tail ? found.slice(0, -tail.length) : found;
    // A lone "/" or "~/" is punctuation, not somewhere on a disk.
    if (path.replace(/[~\\/]/g, "") === "") return before + found;
    return before + hidden(path) + tail;
  });
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Masks whole states, and remembers every path it has seen so an old log
 * line still reads `[hidden]` after the buffer has moved on to another file.
 */
export class PathMasker {
  /** Paths to hide whole, longest first, so a folder doesn't beat a file inside it. */
  private known: string[] = [];
  /** Objects already searched for paths. */
  private seen = new WeakSet<object>();
  /** Masked copies, by the object they're a copy of. State objects are never changed in place. */
  private masked = new WeakMap<object, unknown>();

  /**
   * A copy of `state` with the paths in every string hidden. Anything with
   * no path in it comes back as the same object, so typed arrays (the
   * buffer's bytes) and unchanged parts keep their identity. `skip` names
   * top-level keys to leave alone: text the user is typing, which a masked
   * copy would write back into the box.
   */
  mask<T>(state: T, skip: readonly string[] = []): T {
    this.collect(state);
    if (skip.length === 0 || typeof state !== "object" || state === null) {
      return this.copy(state) as T;
    }
    const whole = state as Record<string, unknown>;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(whole)) {
      out[key] = skip.includes(key) ? value : this.copy(value);
      if (out[key] !== value) changed = true;
    }
    return (changed ? out : state) as T;
  }

  /**
   * Hide `path` wherever it appears from now on, and the folder it's in.
   * For paths as they come into the app (a file panel's answer, a
   * remembered setting): one that then fails to open is never in the state,
   * but it is in the error that says so.
   */
  remember(path: string | null | undefined): void {
    if (!path || !PATH_START.test(path)) return;
    const dir = parent(path);
    // A top-level folder ("/tmp", "C:\\Users") is in too many paths to be one.
    const deep = dir !== null && dir.split(/[\\/]/).filter(Boolean).length >= 2;
    let added = false;
    for (const known of deep ? [path, dir] : [path]) {
      if (this.known.includes(known)) continue;
      this.known.push(known);
      added = true;
    }
    if (added) {
      this.known.sort((a, b) => b.length - a.length);
      // What was masked without knowing these may have missed them.
      this.masked = new WeakMap();
    }
  }

  /** Remember the paths held under the field names that hold one. */
  private collect(value: unknown, key = ""): void {
    if (typeof value === "string") {
      if (PATH_KEY.test(key)) this.remember(value);
      return;
    }
    if (typeof value !== "object" || value === null || this.seen.has(value)) return;
    if (Array.isArray(value)) {
      this.seen.add(value);
      for (const item of value) this.collect(item, key);
    } else if (isPlainObject(value)) {
      this.seen.add(value);
      for (const [name, item] of Object.entries(value)) this.collect(item, name);
    }
  }

  private copy(value: unknown): unknown {
    if (typeof value === "string") return maskPaths(value, this.known);
    if (typeof value !== "object" || value === null) return value;
    const array = Array.isArray(value);
    // Typed arrays, Maps and the like hold no text of ours.
    if (!array && !isPlainObject(value)) return value;
    const cached = this.masked.get(value);
    if (cached !== undefined) return cached;
    let changed = false;
    let out: unknown;
    if (array) {
      const items = value.map((item) => this.copy(item));
      changed = items.some((item, i) => item !== value[i]);
      out = changed ? items : value;
    } else {
      const fields: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        fields[key] = this.copy(item);
        if (fields[key] !== item) changed = true;
      }
      out = changed ? fields : value;
    }
    this.masked.set(value, out);
    return out;
  }
}

/** The app's masker: one memory of paths for both benches. */
export const pathMasker = new PathMasker();
