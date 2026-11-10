import { describe, expect, it } from "vitest";
import {
  createEditor,
  editorReducer,
  keyToAction,
  replaceAll,
  selectionRange,
  type EditorAction,
  type EditorState,
  type KeyInput,
} from "./editor";
import { createEditState } from "./editModel";

const ramp = (length: number) => Uint8Array.from({ length }, (_, i) => i & 0xff);
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

const run = (state: EditorState, ...actions: EditorAction[]) =>
  actions.reduce(editorReducer, state);

const ctx = { perRow: 16, pageRows: 4, readOnly: false };

/** Apply the action a key maps to; fail if it maps to none. */
function press(state: EditorState, key: string | KeyInput, c = ctx): EditorState {
  const input = typeof key === "string" ? { key } : key;
  const result = keyToAction(state, input, c);
  if (result?.kind !== "action") throw new Error(`${input.key} mapped to ${JSON.stringify(result)}`);
  return editorReducer(state, result.action);
}

const type = (state: EditorState, text: string) =>
  [...text].reduce((s, key) => press(s, key), state);

describe("editor reducer", () => {
  it("types hex a nibble at a time, then advances", () => {
    let s = createEditor(new Uint8Array(4));
    s = press(s, "a");
    expect(s.edit.bytes[0]).toBe(0xa0);
    expect(s.nibble).toBe(1);
    expect(s.cursor).toBe(0);
    s = press(s, "B");
    expect(s.edit.bytes[0]).toBe(0xab);
    expect(s.nibble).toBe(0);
    expect(s.cursor).toBe(1);
  });

  it("keeps the low nibble when only the high one has been typed", () => {
    const s = press(createEditor(Uint8Array.of(0x0f)), "3");
    expect(s.edit.bytes[0]).toBe(0x3f);
  });

  it("undoes a typed byte as one step", () => {
    let s = type(createEditor(new Uint8Array(4)), "12345");
    expect(Array.from(s.edit.bytes)).toEqual([0x12, 0x34, 0x50, 0]);
    expect(s.edit.undoStack).toHaveLength(3);
    s = run(s, { type: "undo" }, { type: "undo" });
    expect(Array.from(s.edit.bytes)).toEqual([0x12, 0, 0, 0]);
    expect(s.cursor).toBe(1); // selects what the undo touched
  });

  it("does not merge a byte's low nibble into an older step when the high nibble was a no-op", () => {
    let s = createEditor(new Uint8Array(2));
    s = type(s, "12"); // byte 0 = 12, cursor → 1
    s = run(s, { type: "move", to: 0 });
    s = type(s, "13"); // high nibble 1 is unchanged; low nibble 3 changes
    expect(s.edit.bytes[0]).toBe(0x13);
    s = run(s, { type: "undo" });
    expect(s.edit.bytes[0]).toBe(0x12);
  });

  it("stays on the last byte when typing at the end", () => {
    const s = type(createEditor(new Uint8Array(2)), "aabbcc");
    expect(Array.from(s.edit.bytes)).toEqual([0xaa, 0xcc]);
    expect(s.cursor).toBe(1);
  });

  it("types characters in the ASCII pane", () => {
    let s = run(createEditor(new Uint8Array(4)), { type: "set-pane", pane: "ascii" });
    s = type(s, "Hi!");
    expect(Array.from(s.edit.bytes)).toEqual([0x48, 0x69, 0x21, 0]);
    expect(s.cursor).toBe(3);
  });

  it("resets the half-typed nibble on a move or pane switch", () => {
    let s = press(createEditor(new Uint8Array(4)), "f");
    expect(press(s, "ArrowRight").nibble).toBe(0);
    s = run(s, { type: "set-pane", pane: "ascii" });
    expect(s.nibble).toBe(0);
  });

  it("extends and collapses the selection", () => {
    let s = createEditor(ramp(64));
    s = run(s, { type: "move", to: 5 }, { type: "move", to: 9, extend: true });
    expect(selectionRange(s)).toEqual({ start: 5, end: 10 });
    s = run(s, { type: "move", to: 2, extend: true });
    expect(selectionRange(s)).toEqual({ start: 2, end: 6 });
    s = run(s, { type: "move", to: 7 });
    expect(selectionRange(s)).toEqual({ start: 7, end: 8 });
    s = run(s, { type: "select-all" });
    expect(selectionRange(s)).toEqual({ start: 0, end: 64 });
  });

  it("clamps moves and selections to the buffer", () => {
    const s = run(createEditor(ramp(10)), { type: "select", anchor: -4, cursor: 99 });
    expect(selectionRange(s)).toEqual({ start: 0, end: 10 });
  });

  it("writes a paste at the offset and selects what landed", () => {
    const s = run(createEditor(new Uint8Array(4)), {
      type: "write",
      offset: 2,
      bytes: Uint8Array.of(1, 2, 3),
    });
    expect(Array.from(s.edit.bytes)).toEqual([0, 0, 1, 2]);
    expect(selectionRange(s)).toEqual({ start: 2, end: 4 });
  });

  it("fills the selection", () => {
    const s = run(
      createEditor(new Uint8Array(8)),
      { type: "select", anchor: 2, cursor: 4 },
      { type: "fill", value: 0xee },
    );
    expect(Array.from(s.edit.bytes)).toEqual([0, 0, 0xee, 0xee, 0xee, 0, 0, 0]);
  });

  it("reverts and resets", () => {
    let s = type(createEditor(new Uint8Array(4)), "ffff");
    s = run(s, { type: "revert" });
    expect(s.edit.changedCount).toBe(0);
    const other = Uint8Array.of(9);
    s = run(s, { type: "reset", data: other });
    expect(s.edit.original).toBe(other);
    expect(s.edit.undoStack).toHaveLength(0);
    expect(s.cursor).toBe(0);
  });

  it("does nothing to an empty buffer", () => {
    const s = createEditor(new Uint8Array(0));
    expect(run(s, { type: "type-hex", digit: 1 })).toBe(s);
    expect(run(s, { type: "type-char", code: 65 })).toBe(s);
    expect(selectionRange(s)).toEqual({ start: 0, end: 0 });
  });
});

describe("replaceAll", () => {
  it("replaces every match as one undo step", () => {
    const s = replaceAll(
      createEditState(ascii("xabxxabx")),
      ascii("ab"),
      ascii("CD"),
    );
    expect(String.fromCharCode(...s.bytes)).toBe("xCDxxCDx");
    expect(s.undoStack).toHaveLength(1);
  });

  it("refuses a replacement of a different length", () => {
    const e = createEditState(ascii("ab"));
    expect(replaceAll(e, ascii("ab"), ascii("abc"))).toBe(e);
    expect(replaceAll(e, ascii("zz"), ascii("yy"))).toBe(e);
  });
});

describe("keyToAction", () => {
  const at = (cursor: number, length = 100) =>
    run(createEditor(ramp(length)), { type: "move", to: cursor });

  it("moves with arrows, a row at a time vertically", () => {
    expect(press(at(20), "ArrowLeft").cursor).toBe(19);
    expect(press(at(20), "ArrowRight").cursor).toBe(21);
    expect(press(at(20), "ArrowUp").cursor).toBe(4);
    expect(press(at(20), "ArrowDown").cursor).toBe(36);
  });

  it("does not leave the column at the top and bottom edges", () => {
    expect(press(at(3), "ArrowUp").cursor).toBe(3);
    expect(press(at(90), "ArrowDown").cursor).toBe(90);
    expect(press(at(0), "ArrowLeft").cursor).toBe(0);
    expect(press(at(99), "ArrowRight").cursor).toBe(99);
  });

  it("pages by whole viewports, stopping in the same column at the ends", () => {
    expect(press(at(70), "PageUp").cursor).toBe(6); // 70 - 64
    expect(press(at(20), "PageUp").cursor).toBe(4);
    expect(press(at(5), "PageDown").cursor).toBe(69);
    expect(press(at(50), "PageDown").cursor).toBe(98); // last row, column 2
    expect(press(at(60), "PageDown").cursor).toBe(99); // column past the end
  });

  it("goes to the row ends with Home / End and the buffer ends with Cmd/Ctrl", () => {
    expect(press(at(20), "Home").cursor).toBe(16);
    expect(press(at(20), "End").cursor).toBe(31);
    expect(press(at(97), "End").cursor).toBe(99);
    expect(press(at(50), { key: "Home", metaKey: true }).cursor).toBe(0);
    expect(press(at(50), { key: "End", ctrlKey: true }).cursor).toBe(99);
  });

  it("extends the selection with Shift", () => {
    const s = press(at(20), { key: "ArrowDown", shiftKey: true });
    expect(selectionRange(s)).toEqual({ start: 20, end: 37 });
  });

  it("maps undo / redo on both Cmd and Ctrl", () => {
    const s = at(0);
    expect(keyToAction(s, { key: "z", metaKey: true }, ctx)).toEqual({
      kind: "action",
      action: { type: "undo" },
    });
    expect(keyToAction(s, { key: "Z", ctrlKey: true, shiftKey: true }, ctx)).toEqual({
      kind: "action",
      action: { type: "redo" },
    });
    expect(keyToAction(s, { key: "y", ctrlKey: true }, ctx)).toEqual({
      kind: "action",
      action: { type: "redo" },
    });
  });

  it("maps find, find next / previous and go to", () => {
    const s = at(0);
    expect(keyToAction(s, { key: "f", metaKey: true }, ctx)).toEqual({ kind: "ui", command: "find" });
    expect(keyToAction(s, { key: "g", ctrlKey: true }, ctx)).toEqual({ kind: "ui", command: "find-next" });
    expect(keyToAction(s, { key: "G", metaKey: true, shiftKey: true }, ctx)).toEqual({
      kind: "ui",
      command: "find-previous",
    });
    expect(keyToAction(s, { key: "F3" }, ctx)).toEqual({ kind: "ui", command: "find-next" });
    expect(keyToAction(s, { key: "l", metaKey: true }, ctx)).toEqual({ kind: "ui", command: "go-to" });
  });

  it("switches panes with Tab, and lets Tab leave the grid past the last pane", () => {
    let s = at(0);
    s = press(s, "Tab");
    expect(s.pane).toBe("ascii");
    expect(keyToAction(s, { key: "Tab" }, ctx)).toBeNull();
    s = press(s, { key: "Tab", shiftKey: true });
    expect(s.pane).toBe("hex");
    expect(keyToAction(s, { key: "Tab", shiftKey: true }, ctx)).toBeNull();
  });

  it("ignores non-hex keys in the hex pane and control keys in the ASCII pane", () => {
    const s = at(0);
    expect(keyToAction(s, { key: "g" }, ctx)).toBeNull();
    expect(keyToAction(s, { key: "Enter" }, ctx)).toBeNull();
    expect(keyToAction(s, { key: "a", altKey: true }, ctx)).toBeNull();
    const a = run(s, { type: "set-pane", pane: "ascii" });
    expect(keyToAction(a, { key: "\u0001" }, ctx)).toBeNull();
    expect(keyToAction(a, { key: "€" }, ctx)).toBeNull();
    expect(keyToAction(a, { key: "g" }, ctx)).toEqual({
      kind: "action",
      action: { type: "type-char", code: 0x67 },
    });
  });

  it("blocks edits but not navigation when read-only", () => {
    const ro = { ...ctx, readOnly: true };
    const s = at(0);
    expect(keyToAction(s, { key: "a" }, ro)).toBeNull();
    expect(keyToAction(s, { key: "z", metaKey: true }, ro)).toBeNull();
    expect(keyToAction(s, { key: "ArrowRight" }, ro)).not.toBeNull();
    expect(keyToAction(s, { key: "a", metaKey: true }, ro)).not.toBeNull();
  });

  it("resolves a dispatched key press against the state it lands on", () => {
    // Two presses dispatched before a re-render both act on fresh state.
    const key = { type: "key", input: { key: "ArrowRight" }, context: ctx } as const;
    expect(run(at(0), key, key).cursor).toBe(2);
    const g = { type: "key", input: { key: "g" }, context: ctx } as const;
    const s = at(0);
    expect(run(s, g)).toBe(s);
  });

  it("ignores movement in an empty buffer", () => {
    expect(keyToAction(createEditor(new Uint8Array(0)), { key: "ArrowRight" }, ctx)).toBeNull();
  });
});
