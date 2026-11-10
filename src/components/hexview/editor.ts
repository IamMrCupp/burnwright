// Editor state for HexEditor: the edit model plus cursor, selection, the
// active pane and the half-typed nibble, driven by a pure reducer. Key
// handling is a pure mapping from a key press to an action, so both are
// tested without a DOM.

import {
  createEditState,
  fillRange,
  nextRedo,
  nextUndo,
  redo,
  revert,
  undo,
  writeBytes,
  type EditState,
  type HistoryLimits,
} from "./editModel";
import { findAll } from "./search";

export type Pane = "hex" | "ascii";

export interface EditorState {
  readonly edit: EditState;
  /** Where the selection started (inclusive). */
  readonly anchor: number;
  /** Where the selection ends and typing lands (inclusive). */
  readonly cursor: number;
  readonly pane: Pane;
  /** 1 after the high nibble of the cursor byte has been typed in the hex pane. */
  readonly nibble: 0 | 1;
  /** Bumped per typed byte so its two nibbles undo as one step. */
  readonly typing: number;
}

export type EditorAction =
  | { type: "reset"; data: Uint8Array; limits?: HistoryLimits }
  | { type: "move"; to: number; extend?: boolean; pane?: Pane }
  | { type: "select"; anchor: number; cursor: number }
  | { type: "select-all" }
  | { type: "set-pane"; pane: Pane }
  | { type: "type-hex"; digit: number }
  | { type: "type-char"; code: number }
  | { type: "write"; offset: number; bytes: Uint8Array }
  | { type: "fill"; value: number }
  | { type: "replace-all"; pattern: Uint8Array; replacement: Uint8Array }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "revert" }
  /** A key press, resolved with {@link keyToAction} against the state at
   *  dispatch time, so rapid presses never act on a stale cursor. */
  | { type: "key"; input: KeyInput; context: KeyContext };

export function createEditor(data: Uint8Array, limits?: HistoryLimits): EditorState {
  return {
    edit: createEditState(data, limits),
    anchor: 0,
    cursor: 0,
    pane: "hex",
    nibble: 0,
    typing: 0,
  };
}

/** The selection as a half-open [start, end) range. Never empty for a non-empty buffer. */
export function selectionRange(s: EditorState): { start: number; end: number } {
  if (s.edit.bytes.length === 0) return { start: 0, end: 0 };
  return {
    start: Math.min(s.anchor, s.cursor),
    end: Math.max(s.anchor, s.cursor) + 1,
  };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  const length = state.edit.bytes.length;
  const clamp = (i: number) => Math.min(Math.max(Math.floor(i), 0), Math.max(length - 1, 0));

  switch (action.type) {
    case "reset":
      return createEditor(action.data, action.limits ?? state.edit.limits);

    case "move": {
      const cursor = clamp(action.to);
      return {
        ...state,
        cursor,
        anchor: action.extend ? state.anchor : cursor,
        pane: action.pane ?? state.pane,
        nibble: 0,
      };
    }

    case "select":
      return { ...state, anchor: clamp(action.anchor), cursor: clamp(action.cursor), nibble: 0 };

    case "select-all":
      return { ...state, anchor: 0, cursor: clamp(length - 1), nibble: 0 };

    case "set-pane":
      return action.pane === state.pane ? state : { ...state, pane: action.pane, nibble: 0 };

    case "type-hex": {
      if (length === 0) return state;
      const at = state.cursor;
      const current = state.edit.bytes[at];
      const digit = action.digit & 0x0f;
      if (state.nibble === 0) {
        const typing = state.typing + 1;
        const value = (digit << 4) | (current & 0x0f);
        return {
          ...state,
          edit: writeBytes(state.edit, at, [value], { coalesce: typing }),
          anchor: at,
          nibble: 1,
          typing,
        };
      }
      const value = (current & 0xf0) | digit;
      const cursor = clamp(at + 1);
      return {
        ...state,
        edit: writeBytes(state.edit, at, [value], { coalesce: state.typing }),
        cursor,
        anchor: cursor,
        nibble: 0,
      };
    }

    case "type-char": {
      if (length === 0) return state;
      const at = state.cursor;
      const cursor = clamp(at + 1);
      return {
        ...state,
        edit: writeBytes(state.edit, at, [action.code & 0xff]),
        cursor,
        anchor: cursor,
        nibble: 0,
      };
    }

    case "write": {
      if (length === 0 || action.bytes.length === 0) return state;
      const offset = clamp(action.offset);
      const end = Math.min(offset + action.bytes.length, length);
      return {
        ...state,
        edit: writeBytes(state.edit, offset, action.bytes),
        anchor: offset,
        cursor: end - 1,
        nibble: 0,
      };
    }

    case "fill": {
      const { start, end } = selectionRange(state);
      return { ...state, edit: fillRange(state.edit, start, end, action.value), nibble: 0 };
    }

    case "replace-all": {
      const edit = replaceAll(state.edit, action.pattern, action.replacement);
      return edit === state.edit ? state : { ...state, edit, nibble: 0 };
    }

    case "undo": {
      const patch = nextUndo(state.edit);
      if (!patch) return state;
      return selectPatch({ ...state, edit: undo(state.edit) }, patch.offset, patch.after.length);
    }

    case "redo": {
      const patch = nextRedo(state.edit);
      if (!patch) return state;
      return selectPatch({ ...state, edit: redo(state.edit) }, patch.offset, patch.after.length);
    }

    case "revert":
      return { ...state, edit: revert(state.edit), nibble: 0 };

    case "key": {
      const result = keyToAction(state, action.input, action.context);
      return result?.kind === "action" && result.action.type !== "key"
        ? editorReducer(state, result.action)
        : state;
    }
  }
}

/** Select the span an undo or redo touched, so the user sees what changed. */
function selectPatch(state: EditorState, offset: number, length: number): EditorState {
  return { ...state, anchor: offset, cursor: offset + Math.max(length, 1) - 1, nibble: 0 };
}

/**
 * Overwrite every non-overlapping match of `pattern` with `replacement`, as
 * one undo step. The two must be the same length: the buffer size is fixed.
 */
export function replaceAll(
  edit: EditState,
  pattern: Uint8Array,
  replacement: Uint8Array,
): EditState {
  if (pattern.length === 0 || pattern.length !== replacement.length) return edit;
  const hits = findAll(edit.bytes, pattern);
  if (hits.length === 0) return edit;
  const start = hits[0];
  const end = hits[hits.length - 1] + pattern.length;
  const span = edit.bytes.slice(start, end);
  for (const hit of hits) span.set(replacement, hit - start);
  return writeBytes(edit, start, span);
}

// ---------------------------------------------------------------------------
// Keys

/** The parts of a KeyboardEvent the mapping looks at. */
export interface KeyInput {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

export interface KeyContext {
  /** Bytes per row. */
  perRow: number;
  /** Whole rows in the viewport, for Page Up / Page Down. */
  pageRows: number;
  readOnly: boolean;
}

/** Editor commands a key can trigger that live outside the reducer. */
export type UiCommand = "find" | "find-next" | "find-previous" | "go-to";

export type KeyResult =
  | { kind: "action"; action: EditorAction }
  | { kind: "ui"; command: UiCommand }
  | null;

/**
 * Map a key press to an editor action, a UI command, or null (let the
 * browser have it). Cmd and Ctrl are both accepted as the shortcut modifier
 * so the same bindings work on macOS, Windows and Linux.
 */
export function keyToAction(
  state: EditorState,
  e: KeyInput,
  ctx: KeyContext,
): KeyResult {
  const mod = Boolean(e.metaKey || e.ctrlKey);
  const shift = Boolean(e.shiftKey);
  const key = e.key;
  const length = state.edit.bytes.length;
  const perRow = Math.max(1, ctx.perRow);
  const page = perRow * Math.max(1, ctx.pageRows);
  const act = (action: EditorAction): KeyResult => ({ kind: "action", action });
  const move = (to: number): KeyResult =>
    length === 0 ? null : act({ type: "move", to, extend: shift });

  if (mod && !e.altKey) {
    const lower = key.toLowerCase();
    if (lower === "z" && !ctx.readOnly) return act({ type: shift ? "redo" : "undo" });
    if (lower === "y" && !shift && !ctx.readOnly) return act({ type: "redo" });
    if (lower === "a" && !shift) return length === 0 ? null : act({ type: "select-all" });
    if (lower === "f" && !shift) return { kind: "ui", command: "find" };
    if (lower === "g") return { kind: "ui", command: shift ? "find-previous" : "find-next" };
    if (lower === "l" && !shift) return { kind: "ui", command: "go-to" };
    if (key === "Home") return move(0);
    if (key === "End") return move(length - 1);
  }

  if (!mod && !e.altKey) {
    switch (key) {
      case "ArrowLeft":
        return move(state.cursor - 1);
      case "ArrowRight":
        return move(state.cursor + 1);
      case "ArrowUp":
        return move(state.cursor >= perRow ? state.cursor - perRow : state.cursor);
      case "ArrowDown":
        return move(state.cursor + perRow < length ? state.cursor + perRow : state.cursor);
      case "PageUp":
        return move(state.cursor - page < 0 ? state.cursor % perRow : state.cursor - page);
      case "PageDown":
        return move(pageDownTarget(state.cursor, page, perRow, length));
      case "Home":
        return move(state.cursor - (state.cursor % perRow));
      case "End":
        return move(state.cursor - (state.cursor % perRow) + perRow - 1);
      case "Tab":
        if (shift ? state.pane === "hex" : state.pane === "ascii") return null;
        return act({ type: "set-pane", pane: state.pane === "hex" ? "ascii" : "hex" });
      case "F3":
        return { kind: "ui", command: shift ? "find-previous" : "find-next" };
    }

    if (ctx.readOnly || length === 0 || key.length !== 1) return null;
    if (state.pane === "hex") {
      const digit = parseInt(key, 16);
      return Number.isNaN(digit) ? null : act({ type: "type-hex", digit });
    }
    const code = key.charCodeAt(0);
    return code >= 0x20 && code <= 0xff ? act({ type: "type-char", code }) : null;
  }

  return null;
}

/** Page Down: a page further, or the same column on the last row. */
function pageDownTarget(cursor: number, page: number, perRow: number, length: number): number {
  if (cursor + page < length) return cursor + page;
  const lastRowStart = Math.floor((length - 1) / perRow) * perRow;
  return Math.min(lastRowStart + (cursor % perRow), length - 1);
}
