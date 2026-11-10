import { act, createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HexEditor, type HexEditorHandle } from "./HexEditor";

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const ramp = (length: number) => Uint8Array.from({ length }, (_, i) => i & 0xff);

const size = { height: 420, rowHeight: 20, overscan: 4 };

const grid = () => screen.getByRole("grid");
/** The hex cell for `index`. */
const hexCell = (index: number) =>
  document.querySelector<HTMLElement>(`.hv-byte[data-index="${index}"]`)!;
const charCell = (index: number) =>
  document.querySelector<HTMLElement>(`.hv-char[data-index="${index}"]`)!;
const status = () => screen.getByText(/^Start /).textContent;

function keys(...presses: Array<string | { key: string } & Record<string, unknown>>) {
  for (const p of presses) {
    fireEvent.keyDown(grid(), typeof p === "string" ? { key: p } : p);
  }
}

/** A fake ClipboardEvent payload for fireEvent.copy / paste. */
function clipboard(text = "") {
  const store = new Map<string, string>([["text/plain", text]]);
  return {
    clipboardData: {
      getData: (t: string) => store.get(t) ?? "",
      setData: (t: string, v: string) => void store.set(t, v),
    },
    store,
  };
}

describe("HexEditor", () => {
  it("types hex into the grid, marks edited bytes and reports the new buffer", () => {
    const data = new Uint8Array(32);
    const onChange = vi.fn();
    render(<HexEditor data={data} onChange={onChange} {...size} />);

    fireEvent.mouseDown(hexCell(4), { button: 0 });
    keys("d", "e", "a", "d");

    expect(hexCell(4)).toHaveTextContent("DE");
    expect(hexCell(5)).toHaveTextContent("AD");
    expect(hexCell(4)).toHaveClass("hv-edited");
    expect(charCell(4)).toHaveClass("hv-edited");
    expect(hexCell(3)).not.toHaveClass("hv-edited");
    expect(screen.getByText("2 bytes edited")).toBeInTheDocument();

    const [bytes, info] = onChange.mock.calls[onChange.mock.calls.length - 1];
    expect(Array.from(bytes.subarray(4, 6))).toEqual([0xde, 0xad]);
    expect(info).toEqual({ dirty: true });
    // The caller's buffer is untouched.
    expect(data.every((b) => b === 0)).toBe(true);
  });

  it("does not report a change on mount", () => {
    const onChange = vi.fn();
    render(<HexEditor data={ramp(16)} onChange={onChange} {...size} />);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("types characters into the ASCII gutter", () => {
    render(<HexEditor data={new Uint8Array(16)} {...size} />);
    fireEvent.mouseDown(charCell(2), { button: 0 });
    keys("O", "K");
    expect(charCell(2)).toHaveTextContent("O");
    expect(charCell(3)).toHaveTextContent("K");
    expect(hexCell(2)).toHaveTextContent("4F");
  });

  it("undoes and redoes with the keyboard and the toolbar", () => {
    render(<HexEditor data={new Uint8Array(16)} {...size} />);
    fireEvent.mouseDown(hexCell(0), { button: 0 });
    keys("1", "1", "2", "2");
    keys({ key: "z", metaKey: true });
    expect(hexCell(1)).toHaveTextContent("00");
    expect(hexCell(0)).toHaveTextContent("11");
    keys({ key: "z", ctrlKey: true, shiftKey: true });
    expect(hexCell(1)).toHaveTextContent("22");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByText("Unmodified")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(hexCell(0)).toHaveTextContent("11");
  });

  it("reverts every edit", () => {
    const ref = createRef<HexEditorHandle>();
    render(<HexEditor data={ramp(16)} ref={ref} {...size} />);
    fireEvent.mouseDown(hexCell(0), { button: 0 });
    keys("f", "f", "f", "f");
    expect(ref.current!.isDirty()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(ref.current!.isDirty()).toBe(false);
    expect(Array.from(ref.current!.getBytes())).toEqual(Array.from(ramp(16)));
  });

  it("selects with click, shift-click and drag, and shows start, end and length", () => {
    render(<HexEditor data={ramp(64)} {...size} />);
    fireEvent.mouseDown(hexCell(3), { button: 0 });
    expect(status()).toBe("Start 0003 · End 0003 · Length 1 byte (0x1)");

    fireEvent.mouseDown(hexCell(20), { button: 0, shiftKey: true });
    expect(status()).toBe("Start 0003 · End 0014 · Length 18 bytes (0x12)");
    expect(hexCell(10)).toHaveClass("hv-selected");
    fireEvent.mouseUp(window);

    fireEvent.mouseDown(charCell(40), { button: 0 });
    fireEvent.mouseOver(charCell(33), { buttons: 1 });
    expect(status()).toBe("Start 0021 · End 0028 · Length 8 bytes (0x8)");
    fireEvent.mouseUp(window);
    // Moving without a button held does not extend.
    fireEvent.mouseOver(charCell(50), { buttons: 0 });
    expect(status()).toBe("Start 0021 · End 0028 · Length 8 bytes (0x8)");
  });

  it("navigates and extends with the keyboard", () => {
    render(<HexEditor data={ramp(256)} {...size} />);
    fireEvent.mouseDown(hexCell(0), { button: 0 });
    keys("ArrowDown", "ArrowRight", { key: "End", shiftKey: true });
    expect(status()).toBe("Start 0011 · End 001F · Length 15 bytes (0xF)");
    keys({ key: "a", metaKey: true });
    expect(status()).toBe("Start 0000 · End 00FF · Length 256 bytes (0x100)");
  });

  it("goes to an address, relative to the base address", () => {
    render(<HexEditor data={ramp(1024 * 1024)} baseAddress={0x10000} {...size} />);
    fireEvent.change(screen.getByLabelText("Go to"), { target: { value: "0x8FFF0" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(status()).toBe("Start 08FFF0 · End 08FFF0 · Length 1 byte (0x1)");
    expect(hexCell(0x7fff0)).toHaveClass("hv-cursor");

    fireEvent.change(screen.getByLabelText("Go to"), { target: { value: "0x100" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(screen.getByText(/Enter a hex address from 010000 to/)).toBeInTheDocument();
  });

  it("finds hex and ASCII patterns, next and previous, wrapping round", () => {
    const data = ascii("..burn....burn..");
    render(<HexEditor data={data} {...size} />);
    const find = screen.getByLabelText("Find");

    fireEvent.change(find, { target: { value: "62 75" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(status()).toBe("Start 0002 · End 0003 · Length 2 bytes (0x2)");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(status()).toBe("Start 000A · End 000B · Length 2 bytes (0x2)");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(status()).toMatch(/^Start 0002 /);
    expect(screen.getByText(/wrapped to the start/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Find as"), { target: { value: "ascii" } });
    fireEvent.change(find, { target: { value: "burn" } });
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(status()).toBe("Start 000A · End 000D · Length 4 bytes (0x4)");

    fireEvent.change(find, { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Not found")).toBeInTheDocument();
  });

  it("finds next from the keyboard after a search", () => {
    render(<HexEditor data={ascii("ab.ab.ab")} {...size} />);
    fireEvent.change(screen.getByLabelText("Find as"), { target: { value: "ascii" } });
    fireEvent.change(screen.getByLabelText("Find"), { target: { value: "ab" } });
    // The cursor starts on a match, so the first press selects it.
    keys({ key: "g", metaKey: true });
    expect(status()).toMatch(/^Start 0000 · End 0001 /);
    keys({ key: "g", metaKey: true });
    expect(status()).toMatch(/^Start 0003 /);
    keys({ key: "g", metaKey: true, shiftKey: true });
    expect(status()).toMatch(/^Start 0000 /);
  });

  it("replaces one match, then all, and refuses a size change", () => {
    const ref = createRef<HexEditorHandle>();
    render(<HexEditor data={ascii("cat cat cat")} ref={ref} {...size} />);
    fireEvent.change(screen.getByLabelText("Find as"), { target: { value: "ascii" } });
    fireEvent.change(screen.getByLabelText("Find"), { target: { value: "cat" } });
    fireEvent.change(screen.getByLabelText("Replace with"), { target: { value: "dog" } });

    const text = () => String.fromCharCode(...ref.current!.getBytes());
    // First press selects the next match, the second replaces it.
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(text()).toBe("cat cat cat");
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(text()).toBe("dog cat cat");

    fireEvent.click(screen.getByRole("button", { name: "Replace all" }));
    expect(text()).toBe("dog dog dog");
    expect(screen.getByText("Replaced 2 occurrences")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Find"), { target: { value: "dog" } });
    fireEvent.change(screen.getByLabelText("Replace with"), { target: { value: "puppy" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace all" }));
    expect(text()).toBe("dog dog dog");
    expect(screen.getByText(/must be 3 bytes/)).toBeInTheDocument();
  });

  it("fills the selection", () => {
    const ref = createRef<HexEditorHandle>();
    render(<HexEditor data={new Uint8Array(8)} ref={ref} {...size} />);
    fireEvent.mouseDown(hexCell(2), { button: 0 });
    fireEvent.mouseDown(hexCell(5), { button: 0, shiftKey: true });
    fireEvent.change(screen.getByLabelText("Fill selection with"), { target: { value: "a5" } });
    fireEvent.click(screen.getByRole("button", { name: "Fill" }));
    expect(Array.from(ref.current!.getBytes())).toEqual([0, 0, 0xa5, 0xa5, 0xa5, 0xa5, 0, 0]);
  });

  it("copies the selection as hex or ASCII, depending on the pane", () => {
    render(<HexEditor data={ascii("Hello")} {...size} />);
    fireEvent.mouseDown(hexCell(1), { button: 0 });
    fireEvent.mouseDown(hexCell(3), { button: 0, shiftKey: true });
    const hex = clipboard();
    fireEvent.copy(grid(), hex);
    expect(hex.store.get("text/plain")).toBe("65 6C 6C");

    fireEvent.mouseDown(charCell(0), { button: 0 });
    fireEvent.mouseDown(charCell(4), { button: 0, shiftKey: true });
    const text = clipboard();
    fireEvent.copy(grid(), text);
    expect(text.store.get("text/plain")).toBe("Hello");
  });

  it("pastes hex or text over the selection, clipped at the end", () => {
    const ref = createRef<HexEditorHandle>();
    render(<HexEditor data={new Uint8Array(6)} ref={ref} {...size} />);
    fireEvent.mouseDown(hexCell(1), { button: 0 });
    fireEvent.paste(grid(), clipboard("DE AD"));
    expect(Array.from(ref.current!.getBytes())).toEqual([0, 0xde, 0xad, 0, 0, 0]);

    fireEvent.mouseDown(charCell(4), { button: 0 });
    fireEvent.paste(grid(), clipboard("xyz"));
    expect(Array.from(ref.current!.getBytes().subarray(4))).toEqual([0x78, 0x79]);
    expect(screen.getByText(/Pasted 2 of 3 bytes/)).toBeInTheDocument();

    fireEvent.mouseDown(hexCell(0), { button: 0 });
    fireEvent.paste(grid(), clipboard("not hex"));
    expect(screen.getByText(/Can't paste/)).toBeInTheDocument();
  });

  it("is read-only on request: no typing, paste or edit controls", () => {
    const data = ramp(16);
    render(<HexEditor data={data} readOnly {...size} />);
    expect(grid()).toHaveAttribute("aria-readonly", "true");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.queryByLabelText("Replace with")).toBeNull();
    fireEvent.mouseDown(hexCell(0), { button: 0 });
    keys("f", "f");
    fireEvent.paste(grid(), clipboard("AA"));
    expect(hexCell(0)).toHaveTextContent("00");
    // Navigation still works.
    keys("ArrowRight");
    expect(status()).toMatch(/^Start 0001 /);
  });

  it("is an editable grid otherwise, with a label on the cursor byte", () => {
    render(<HexEditor data={ramp(16)} {...size} />);
    expect(grid()).toHaveAttribute("aria-readonly", "false");
    fireEvent.mouseDown(hexCell(2), { button: 0 });
    expect(hexCell(2)).toHaveAttribute("aria-label", "Offset 0002, 02");
  });

  it("starts over when given a new buffer", () => {
    const { rerender } = render(<HexEditor data={new Uint8Array(4)} {...size} />);
    fireEvent.mouseDown(hexCell(0), { button: 0 });
    keys("1", "1");
    expect(screen.getByText("1 byte edited")).toBeInTheDocument();
    rerender(<HexEditor data={ramp(4)} {...size} />);
    expect(screen.getByText("Unmodified")).toBeInTheDocument();
    expect(hexCell(3)).toHaveTextContent("03");
  });

  it("edits a 16 MiB buffer, rendering only the rows in view", () => {
    const data = new Uint8Array(16 * 1024 * 1024).fill(0xff);
    const ref = createRef<HexEditorHandle>();
    render(<HexEditor data={data} ref={ref} {...size} />);
    expect(document.querySelectorAll(".hv-row").length).toBeLessThanOrEqual(28);

    act(() => ref.current!.goToIndex(data.length - 1));
    expect(hexCell(data.length - 1)).toHaveClass("hv-cursor");
    keys("0", "0");
    expect(hexCell(data.length - 1)).toHaveTextContent("00");
    expect(document.querySelectorAll(".hv-row").length).toBeLessThanOrEqual(28);
    expect(data[data.length - 1]).toBe(0xff);
    expect(ref.current!.getBytes()[data.length - 1]).toBe(0);
  });
});
