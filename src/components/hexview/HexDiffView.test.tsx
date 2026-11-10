import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HexDiffView } from "./HexDiffView";

/** Fill byte i with i & 0xff. */
const ramp = (length: number) => {
  const data = new Uint8Array(length);
  for (let i = 0; i < length; i++) data[i] = i & 0xff;
  return data;
};

/** Copy of `data` with each listed byte inverted. */
const flip = (data: Uint8Array, ...indices: number[]) => {
  const out = data.slice();
  for (const i of indices) out[i] ^= 0xff;
  return out;
};

const rows = () => screen.getAllByRole("row");
const address = (row: HTMLElement) =>
  within(row).getByRole("rowheader").textContent;
const cellsAt = (index: number) =>
  document.querySelectorAll<HTMLElement>(`[data-index="${index}"]`);
const marked = (cls: string) =>
  [...document.querySelectorAll<HTMLElement>(`.hv-hex .${cls}`)].map((e) =>
    Number(e.dataset.index),
  );
const summary = () => screen.getByRole("status").textContent;
const next = () => screen.getByRole("button", { name: "Next difference" });
const prev = () => screen.getByRole("button", { name: "Previous difference" });

// 420 px tall with 20 px rows: a 20 px header and a 400 px (20-row) viewport.
const size = { height: 420, rowHeight: 20, overscan: 4 };

describe("HexDiffView", () => {
  it("says the buffers match and disables navigation when they do", () => {
    render(<HexDiffView a={ramp(64)} b={ramp(64)} aLabel="Read" bLabel="File" {...size} />);
    expect(summary()).toBe("Read and File match");
    expect(next()).toBeDisabled();
    expect(prev()).toBeDisabled();
    expect(document.querySelectorAll("[class*=hv-diff-]")).toHaveLength(0);
  });

  it("highlights differing bytes in both the hex and ASCII columns", () => {
    const a = ramp(64);
    render(<HexDiffView a={a} b={flip(a, 3, 4, 40)} aLabel="Read" bLabel="File" {...size} />);

    expect(summary()).toBe("3 bytes differ");
    expect(marked("hv-diff-changed")).toEqual([3, 4, 40]);
    for (const el of cellsAt(40)) {
      expect(el).toHaveClass("hv-diff-changed");
      expect(el).toHaveAttribute("title", "Read 28 · File D7");
    }
    expect(cellsAt(5)[0]).not.toHaveClass("hv-diff-changed");
  });

  it("uses the singular for one differing byte", () => {
    const a = ramp(16);
    render(<HexDiffView a={a} b={flip(a, 0)} {...size} />);
    expect(summary()).toBe("1 byte differs");
  });

  it("marks a's tail as extra when a is longer", () => {
    const a = ramp(40);
    render(<HexDiffView a={a} b={flip(a.slice(0, 32), 1)} aLabel="Read" bLabel="File" {...size} />);

    expect(summary()).toBe("9 bytes differ · 1 changed · Read has 8 extra bytes");
    expect(marked("hv-diff-changed")).toEqual([1]);
    expect(marked("hv-diff-extra")).toEqual([32, 33, 34, 35, 36, 37, 38, 39]);
    expect(cellsAt(39)[0]).toHaveAttribute("title", "Not in File");
    expect(cellsAt(39)[0].textContent).toBe("27");
  });

  it("shows b's tail after a, marked missing, when b is longer", () => {
    const b = ramp(40);
    render(<HexDiffView a={b.slice(0, 36)} b={b} aLabel="Read" bLabel="File" {...size} />);

    expect(summary()).toBe("4 bytes differ · Read is 4 bytes short");
    expect(marked("hv-diff-missing")).toEqual([36, 37, 38, 39]);
    const [hex, ascii] = cellsAt(38);
    expect(hex.textContent).toBe("26"); // File's value, shown struck through
    expect(ascii.textContent).toBe("&");
    expect(hex).toHaveAttribute("title", "Missing from Read · File 26");
  });

  it("shows only b's bytes, all missing, when a is empty", () => {
    render(<HexDiffView a={new Uint8Array(0)} b={ramp(4)} {...size} />);
    expect(marked("hv-diff-missing")).toEqual([0, 1, 2, 3]);
  });

  it("steps through differences and scrolls each into view", () => {
    // 1 MiB: 65,536 rows, far more than fit in the viewport.
    const a = ramp(1024 * 1024);
    const b = flip(a, 0x20, 0x21, 0x8_0000, 0xf_fff8);
    render(<HexDiffView a={a} b={b} {...size} />);

    expect(prev()).toBeDisabled();
    expect(screen.queryByText(/ of 3 at/)).toBeNull();

    fireEvent.click(next());
    expect(screen.getByText("1 of 3 at 000020")).toBeInTheDocument();
    expect(prev()).toBeDisabled();
    expect(marked("hv-diff-current")).toEqual([0x20, 0x21]);

    fireEvent.click(next());
    expect(screen.getByText("2 of 3 at 080000")).toBeInTheDocument();
    expect(rows().map(address)).toContain("080000");
    expect(marked("hv-diff-current")).toEqual([0x8_0000]);

    fireEvent.click(next());
    expect(screen.getByText("3 of 3 at 0FFFF8")).toBeInTheDocument();
    expect(rows().map(address)).toContain("0FFFF0");
    expect(next()).toBeDisabled();

    fireEvent.click(prev());
    expect(screen.getByText("2 of 3 at 080000")).toBeInTheDocument();
    expect(rows().map(address)).toContain("080000");
    expect(marked("hv-diff-current")).toEqual([0x8_0000]);
  });

  it("navigates to the length-mismatch tail as the last difference", () => {
    const a = ramp(1024 * 1024);
    render(<HexDiffView a={a} b={a.subarray(0, a.length - 16)} {...size} />);
    fireEvent.click(next());
    expect(screen.getByText("1 of 1 at 0FFFF0")).toBeInTheDocument();
    expect(marked("hv-diff-current")).toHaveLength(16);
  });

  it("offsets the reported address by baseAddress", () => {
    const a = ramp(64);
    render(<HexDiffView a={a} b={flip(a, 0x30)} baseAddress={0x0800_0000} {...size} />);
    fireEvent.click(next());
    expect(screen.getByText("1 of 1 at 08000030")).toBeInTheDocument();
  });

  it("resets the position when the buffers change", () => {
    const a = ramp(64);
    const { rerender } = render(<HexDiffView a={a} b={flip(a, 8)} {...size} />);
    fireEvent.click(next());
    expect(screen.getByText("1 of 1 at 0008")).toBeInTheDocument();

    rerender(<HexDiffView a={a} b={flip(a, 9, 20)} {...size} />);
    expect(screen.queryByText(/ of /)).toBeNull();
    expect(summary()).toBe("2 bytes differ");
    expect(marked("hv-diff-current")).toEqual([]);
  });

  it("highlights only rendered rows of a 16 MiB diff", () => {
    const size16 = 16 * 1024 * 1024;
    const a = new Uint8Array(size16);
    const b = flip(a, 5, size16 - 1);
    render(<HexDiffView a={a} b={b} {...size} />);
    expect(summary()).toBe("2 bytes differ");
    expect(marked("hv-diff-changed")).toEqual([5]);
    fireEvent.click(next());
    fireEvent.click(next());
    expect(marked("hv-diff-changed")).toEqual([size16 - 1]);
  });

  it("does not modify either buffer", () => {
    const a = ramp(20);
    const b = ramp(32);
    const [copyA, copyB] = [a.slice(), b.slice()];
    render(<HexDiffView a={a} b={b} {...size} />);
    expect(a).toEqual(copyA);
    expect(b).toEqual(copyB);
  });
});
