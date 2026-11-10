import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type Ref,
} from "react";
import {
  HexView,
  type ByteDecorator,
  type ByteMouseHandler,
  type HexViewHandle,
  type HexViewProps,
} from "./HexView";
import { canRedo, canUndo, isDirty, type HistoryLimits } from "./editModel";
import {
  createEditor,
  editorReducer,
  keyToAction,
  selectionRange,
  type EditorState,
  type UiCommand,
} from "./editor";
import { addressDigitsFor, byteToAscii, byteToHex, formatAddress } from "./format";
import {
  bytesToHexText,
  encodeAscii,
  findAll,
  findPattern,
  parseAddress,
  parseHexPattern,
  parsePattern,
  type PatternMode,
} from "./search";
import "./HexEditor.css";

export interface HexEditorHandle {
  /** The buffer with edits applied. Treat it as read-only; copy before changing it. */
  getBytes(): Uint8Array;
  /** True if any byte differs from the original. */
  isDirty(): boolean;
  undo(): void;
  redo(): void;
  /** Put every edited byte back (undoable). */
  revert(): void;
  /** Move the cursor to `data[index]` and scroll it into view. */
  goToIndex(index: number): void;
  /** Move keyboard focus to the grid. */
  focus(): void;
}

export interface HexEditorProps
  extends Omit<
    HexViewProps,
    | "data"
    | "decorateByte"
    | "ref"
    | "onByteClick"
    | "onByteMouseDown"
    | "onByteMouseEnter"
    | "onKeyDown"
    | "onCopy"
    | "onPaste"
    | "readOnly"
  > {
  /** The bytes to edit. Never mutated; edits go to a copy. A new array resets the editor. */
  data: Uint8Array;
  /** Allow selection, find, go-to and copy, but no changes. Default false. */
  readOnly?: boolean;
  /** Bounds on the undo history. */
  history?: HistoryLimits;
  /**
   * Called after each change with the edited buffer (a new array each time;
   * treat it as read-only) and whether it differs from `data`.
   */
  onChange?: (bytes: Uint8Array, info: { dirty: boolean }) => void;
  ref?: Ref<HexEditorHandle>;
}

/**
 * Overwrite-mode hex editor over a fixed-size buffer: select with the mouse
 * or keyboard, type hex or ASCII, undo / redo, find / replace, go to an
 * address, copy and paste. Built on HexView, so it stays virtualised.
 */
export function HexEditor({
  data,
  readOnly = false,
  history,
  onChange,
  baseAddress = 0,
  bytesPerRow = 16,
  addressDigits,
  className,
  "aria-label": ariaLabel = "Hex editor",
  ref,
  ...viewProps
}: HexEditorProps) {
  const [state, dispatch] = useReducer(editorReducer, data, (d) =>
    createEditor(d, history),
  );
  // A new buffer means a new document. (Adjusting state during render is
  // React's recommended alternative to an effect here.)
  if (state.edit.original !== data) dispatch({ type: "reset", data, limits: history });

  const viewRef = useRef<HexViewHandle>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const goToRef = useRef<HTMLInputElement>(null);
  const dragging = useRef(false);
  const ids = useId();

  const [notice, setNotice] = useState("");
  const [findMode, setFindMode] = useState<PatternMode>("hex");
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [goToText, setGoToText] = useState("");
  const [fillText, setFillText] = useState("FF");

  const { bytes, original } = state.edit;
  const perRow = Math.max(1, Math.floor(bytesPerRow));
  const digits = addressDigitsFor(bytes.length, baseAddress, addressDigits);
  const addr = (index: number) => formatAddress(baseAddress + index, digits);
  const { start, end } = selectionRange(state);
  const { cursor, nibble, pane } = state;

  // Keep the cursor on screen as it moves or the bytes under it change.
  useLayoutEffect(() => {
    viewRef.current?.revealIndex(cursor);
  }, [cursor, bytes]);

  // Report edits. The first render reports nothing: `data` is unchanged.
  const reported = useRef(bytes);
  useEffect(() => {
    if (reported.current === bytes) return;
    reported.current = bytes;
    onChange?.(bytes, { dirty: isDirty(state.edit) });
  }, [bytes, onChange, state.edit]);

  useEffect(() => {
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      getBytes: () => state.edit.bytes,
      isDirty: () => isDirty(state.edit),
      undo: () => dispatch({ type: "undo" }),
      redo: () => dispatch({ type: "redo" }),
      revert: () => dispatch({ type: "revert" }),
      goToIndex: (index: number) => dispatch({ type: "move", to: index }),
      focus: () => viewRef.current?.focus(),
    }),
    [state.edit],
  );

  const decorateByte = useCallback<ByteDecorator>(
    (index, value) => {
      let cls = "";
      const was = original[index];
      if (value !== was) cls += " hv-edited";
      if (end - start > 1 && index >= start && index < end) cls += " hv-selected";
      const isCursor = index === cursor;
      if (isCursor) cls += nibble ? " hv-cursor hv-cursor-low" : " hv-cursor";
      if (!cls) return undefined;
      return {
        className: cls.slice(1),
        title: value !== was ? `Was ${byteToHex(was)}` : undefined,
        label: isCursor
          ? `Offset ${addr(index)}, ${byteToHex(value)}${value !== was ? ", edited" : ""}`
          : undefined,
      };
    },
    // `addr` only depends on baseAddress and digits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [original, start, end, cursor, nibble, baseAddress, digits],
  );

  // --- find / replace / go to -------------------------------------------

  const pattern = (text: string, mode: PatternMode) => {
    const parsed = parsePattern(text, mode);
    if (!parsed.ok) setNotice(parsed.error);
    return parsed.ok ? parsed.bytes : null;
  };

  /** True if the selection is exactly one occurrence of `needle`. */
  const selectionIs = (s: EditorState, needle: Uint8Array) => {
    const sel = selectionRange(s);
    if (sel.end - sel.start !== needle.length) return false;
    for (let i = 0; i < needle.length; i++) {
      if (s.edit.bytes[sel.start + i] !== needle[i]) return false;
    }
    return true;
  };

  const find = (direction: "next" | "previous") => {
    const needle = pattern(findText, findMode);
    if (!needle) return;
    const from =
      direction === "next"
        ? start + (selectionIs(state, needle) ? 1 : 0)
        : start - 1;
    const hit = findPattern(bytes, needle, from, direction);
    if (!hit) {
      setNotice("Not found");
      return;
    }
    dispatch({ type: "select", anchor: hit.index, cursor: hit.index + needle.length - 1 });
    setNotice(
      `Found at ${addr(hit.index)}${hit.wrapped ? ` (wrapped to the ${direction === "next" ? "start" : "end"})` : ""}`,
    );
  };

  const replacement = (needle: Uint8Array) => {
    const bytesOut = pattern(replaceText, findMode);
    if (!bytesOut) return null;
    if (bytesOut.length !== needle.length) {
      setNotice(
        `Replacement must be ${needle.length} byte${needle.length === 1 ? "" : "s"}, the same as the pattern: the buffer size is fixed`,
      );
      return null;
    }
    return bytesOut;
  };

  const replaceOne = () => {
    const needle = pattern(findText, findMode);
    if (!needle) return;
    if (!selectionIs(state, needle)) {
      find("next");
      return;
    }
    const out = replacement(needle);
    if (!out) return;
    dispatch({ type: "write", offset: start, bytes: out });
    setNotice(`Replaced at ${addr(start)}`);
  };

  const replaceEvery = () => {
    const needle = pattern(findText, findMode);
    if (!needle) return;
    const out = replacement(needle);
    if (!out) return;
    const count = findAll(bytes, needle).length;
    if (count === 0) {
      setNotice("Not found");
      return;
    }
    dispatch({ type: "replace-all", pattern: needle, replacement: out });
    setNotice(`Replaced ${count.toLocaleString()} occurrence${count === 1 ? "" : "s"}`);
  };

  const goTo = (e: FormEvent) => {
    e.preventDefault();
    const address = parseAddress(goToText);
    const index = address === null ? -1 : address - baseAddress;
    if (address === null || index < 0 || index >= bytes.length) {
      setNotice(
        bytes.length === 0
          ? "Nothing to go to"
          : `Enter a hex address from ${addr(0)} to ${addr(bytes.length - 1)}`,
      );
      return;
    }
    dispatch({ type: "move", to: index });
    setNotice("");
    viewRef.current?.focus();
  };

  const fill = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseHexPattern(fillText);
    if (!parsed.ok || parsed.bytes.length !== 1) {
      setNotice(parsed.ok ? "Fill takes one byte, e.g. FF" : parsed.error);
      return;
    }
    dispatch({ type: "fill", value: parsed.bytes[0] });
    setNotice(`Filled ${(end - start).toLocaleString()} bytes with ${byteToHex(parsed.bytes[0])}`);
  };

  const runUi = (command: UiCommand) => {
    if (command === "find") findRef.current?.select();
    else if (command === "go-to") goToRef.current?.select();
    else find(command === "find-next" ? "next" : "previous");
  };

  // --- grid events --------------------------------------------------------

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const context = {
      perRow,
      pageRows: viewRef.current?.pageRows() ?? 1,
      readOnly,
    };
    const result = keyToAction(state, e, context);
    if (!result) return;
    e.preventDefault();
    if (result.kind === "action") {
      setNotice("");
      const { key, shiftKey, ctrlKey, metaKey, altKey } = e;
      dispatch({ type: "key", input: { key, shiftKey, ctrlKey, metaKey, altKey }, context });
    } else {
      runUi(result.command);
    }
  };

  const onByteMouseDown = useCallback<ByteMouseHandler>((index, e, cellPane) => {
    if (e.button !== 0) return;
    dragging.current = true;
    dispatch({ type: "move", to: index, extend: e.shiftKey, pane: cellPane });
  }, []);

  const onByteMouseEnter = useCallback<ByteMouseHandler>((index, e) => {
    if (!dragging.current) return;
    if ((e.buttons & 1) === 0) {
      dragging.current = false;
      return;
    }
    dispatch({ type: "move", to: index, extend: true });
  }, []);

  const onCopy = (e: ClipboardEvent<HTMLDivElement>) => {
    if (bytes.length === 0) return;
    const slice = bytes.subarray(start, end);
    const text =
      pane === "hex"
        ? bytesToHexText(slice)
        : Array.from(slice, byteToAscii).join("");
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
    setNotice(`Copied ${slice.length.toLocaleString()} byte${slice.length === 1 ? "" : "s"} as ${pane === "hex" ? "hex" : "ASCII"}`);
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (readOnly || bytes.length === 0) return;
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    const parsed = pane === "hex" ? parseHexPattern(text) : encodeAscii(text);
    if (!parsed.ok) {
      setNotice(`Can't paste: ${parsed.error}`);
      return;
    }
    const fits = Math.min(parsed.bytes.length, bytes.length - start);
    dispatch({ type: "write", offset: start, bytes: parsed.bytes });
    setNotice(
      fits < parsed.bytes.length
        ? `Pasted ${fits.toLocaleString()} of ${parsed.bytes.length.toLocaleString()} bytes: the rest ran past the end`
        : `Pasted ${fits.toLocaleString()} byte${fits === 1 ? "" : "s"}`,
    );
  };

  // --- render --------------------------------------------------------------

  const changed = state.edit.changedCount;
  const empty = bytes.length === 0;
  const value = empty ? 0 : bytes[cursor];
  const length = end - start;
  const id = (name: string) => `${ids}-${name}`;

  return (
    <div
      className={[
        "hexedit",
        `hexedit-pane-${pane}`,
        readOnly ? "hexedit-readonly" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="hexedit-toolbar">
        {!readOnly && (
          <span className="hexedit-group">
            <button
              type="button"
              onClick={() => dispatch({ type: "undo" })}
              disabled={!canUndo(state.edit)}
              title="Undo (Cmd/Ctrl+Z)"
            >
              Undo
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: "redo" })}
              disabled={!canRedo(state.edit)}
              title="Redo (Shift+Cmd/Ctrl+Z)"
            >
              Redo
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: "revert" })}
              disabled={changed === 0}
              title="Put every edited byte back to the original"
            >
              Revert
            </button>
            <span className={changed ? "hexedit-dirty" : "hexedit-clean"}>
              {changed
                ? `${changed.toLocaleString()} byte${changed === 1 ? "" : "s"} edited`
                : "Unmodified"}
            </span>
          </span>
        )}
        <form className="hexedit-group" onSubmit={goTo}>
          <label htmlFor={id("goto")}>Go to</label>
          <input
            id={id("goto")}
            ref={goToRef}
            className="hexedit-input hexedit-narrow"
            value={goToText}
            onChange={(e) => setGoToText(e.target.value)}
            placeholder={addr(0)}
            spellCheck={false}
            autoComplete="off"
          />
          <button type="submit" disabled={empty}>
            Go
          </button>
        </form>
        {!readOnly && (
          <form className="hexedit-group" onSubmit={fill}>
            <label htmlFor={id("fill")}>Fill selection with</label>
            <input
              id={id("fill")}
              className="hexedit-input hexedit-tiny"
              value={fillText}
              onChange={(e) => setFillText(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            <button type="submit" disabled={empty}>
              Fill
            </button>
          </form>
        )}
      </div>

      <form
        className="hexedit-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          find("next");
        }}
      >
        <span className="hexedit-group">
          <label htmlFor={id("find")}>Find</label>
          <select
            aria-label="Find as"
            value={findMode}
            onChange={(e) => setFindMode(e.target.value as PatternMode)}
          >
            <option value="hex">Hex</option>
            <option value="ascii">ASCII</option>
          </select>
          <input
            id={id("find")}
            ref={findRef}
            className="hexedit-input"
            value={findText}
            onChange={(e) => setFindText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.shiftKey) {
                e.preventDefault();
                find("previous");
              } else if (e.key === "Escape") {
                viewRef.current?.focus();
              }
            }}
            placeholder={findMode === "hex" ? "DE AD BE EF" : "text"}
            spellCheck={false}
            autoComplete="off"
          />
          <button type="button" onClick={() => find("previous")} disabled={empty}>
            Previous
          </button>
          <button type="submit" disabled={empty}>
            Next
          </button>
        </span>
        {!readOnly && (
          <span className="hexedit-group">
            <label htmlFor={id("replace")}>Replace with</label>
            <input
              id={id("replace")}
              className="hexedit-input"
              value={replaceText}
              onChange={(e) => setReplaceText(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            <button type="button" onClick={replaceOne} disabled={empty}>
              Replace
            </button>
            <button type="button" onClick={replaceEvery} disabled={empty}>
              Replace all
            </button>
          </span>
        )}
      </form>

      <HexView
        {...viewProps}
        ref={viewRef}
        data={bytes}
        baseAddress={baseAddress}
        bytesPerRow={perRow}
        addressDigits={addressDigits}
        decorateByte={decorateByte}
        onByteMouseDown={onByteMouseDown}
        onByteMouseEnter={onByteMouseEnter}
        onKeyDown={onKeyDown}
        onCopy={onCopy}
        onPaste={onPaste}
        readOnly={readOnly}
        className="hexedit-view"
        aria-label={ariaLabel}
      />

      <div className="hexedit-status">
        <span role="status" aria-live="polite" className="hexedit-selection">
          {empty
            ? "No data"
            : `Start ${addr(start)} · End ${addr(end - 1)} · Length ${length.toLocaleString()} byte${length === 1 ? "" : "s"} (0x${length.toString(16).toUpperCase()})`}
        </span>
        {!empty && (
          <span className="hexedit-value">
            {pane === "hex" ? "Hex" : "ASCII"} · {addr(cursor)} = {byteToHex(value)}
            {value !== original[cursor] && ` (was ${byteToHex(original[cursor])})`}
          </span>
        )}
        {notice && (
          <span className="hexedit-notice" aria-live="polite">
            {notice}
          </span>
        )}
      </div>
    </div>
  );
}
