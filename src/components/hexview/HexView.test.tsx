import { act, createRef } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HexView, type HexViewHandle } from "./HexView";

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** Fill byte i with i & 0xff. */
const ramp = (length: number) => {
  const data = new Uint8Array(length);
  for (let i = 0; i < length; i++) data[i] = i & 0xff;
  return data;
};

const rows = () => screen.getAllByRole("row");
const lastRow = () => rows()[rows().length - 1];
const address = (row: HTMLElement) =>
  within(row).getByRole("rowheader").textContent;
const cells = (row: HTMLElement) => within(row).getAllByRole("gridcell");
const hexOf = (row: HTMLElement) =>
  [...cells(row)[0].querySelectorAll("[data-index]")].map((e) => e.textContent);
const asciiOf = (row: HTMLElement) => cells(row)[1].textContent;

function scrollGrid(scrollTop: number) {
  const grid = screen.getByRole("grid");
  Object.defineProperty(grid, "scrollTop", {
    value: scrollTop,
    configurable: true,
    writable: true,
  });
  fireEvent.scroll(grid);
}

// 420 px tall with 20 px rows: a 20 px header and a 400 px (20-row) viewport.
const size = { height: 420, rowHeight: 20, overscan: 4 };

describe("HexView", () => {
  it("renders address, hex bytes and ASCII for each row", () => {
    render(<HexView data={ascii("Hello, burnwright!\x00\xff")} {...size} />);

    const [first, second] = rows();
    expect(address(first)).toBe("0000");
    expect(hexOf(first)).toEqual([
      "48", "65", "6C", "6C", "6F", "2C", "20", "62",
      "75", "72", "6E", "77", "72", "69", "67", "68",
    ]);
    expect(asciiOf(first)).toBe("Hello, burnwrigh");

    expect(address(second)).toBe("0010");
    expect(hexOf(second)).toEqual(["74", "21", "00", "FF"]);
    expect(asciiOf(second)).toBe("t!..");
  });

  it("pads a short last row so columns stay aligned", () => {
    render(<HexView data={ramp(20)} {...size} />);
    const last = rows()[1];
    expect(cells(last)[0].children).toHaveLength(16);
    expect(cells(last)[0].querySelectorAll(".hv-pad")).toHaveLength(12);
  });

  it("offsets addresses by baseAddress and widens the column to fit", () => {
    render(<HexView data={ramp(48)} baseAddress={0x0800_0000} {...size} />);
    expect(rows().map(address)).toEqual(["08000000", "08000010", "08000020"]);
  });

  it("honours bytesPerRow", () => {
    render(<HexView data={ramp(32)} bytesPerRow={8} {...size} />);
    expect(screen.getByRole("grid")).toHaveAttribute("aria-rowcount", "4");
    expect(rows().map(address)).toEqual(["0000", "0008", "0010", "0018"]);
    expect(hexOf(rows()[1])).toEqual(
      ["08", "09", "0A", "0B", "0C", "0D", "0E", "0F"],
    );
  });

  it("shows an empty state for an empty buffer", () => {
    render(<HexView data={new Uint8Array(0)} {...size} />);
    expect(screen.getByText("No data")).toBeInTheDocument();
    expect(screen.queryAllByRole("row")).toHaveLength(0);
  });

  describe("virtualisation", () => {
    const sixteenMiB = ramp(16 * 1024 * 1024);

    it("renders only the rows in view for a 16 MiB buffer", () => {
      render(<HexView data={sixteenMiB} {...size} />);
      expect(screen.getByRole("grid")).toHaveAttribute(
        "aria-rowcount",
        String(1024 * 1024),
      );
      // 20 visible rows plus 4 overscan below; none above at the top.
      expect(rows()).toHaveLength(24);
      expect(address(rows()[0])).toBe("000000");
    });

    it("swaps rows in as the grid scrolls", () => {
      // 1 MiB stays under the scroll-height cap, so scrolling maps 1:1.
      render(<HexView data={ramp(1024 * 1024)} {...size} />);
      scrollGrid(1000 * 20); // row 1000 at the top

      const shown = rows();
      expect(shown[0]).toHaveAttribute("aria-rowindex", String(1000 - 4 + 1));
      const top = shown.find((r) => address(r) === "003E80"); // 1000 * 16
      expect(top).toBeDefined();
      expect(shown.length).toBeLessThanOrEqual(28);
    });

    it("scrollToIndex brings the last byte into view", () => {
      const data = ramp(1024 * 1024);
      const ref = createRef<HexViewHandle>();
      render(<HexView data={data} ref={ref} {...size} />);
      act(() => ref.current!.scrollToIndex(data.length - 1));
      expect(address(lastRow())).toBe("0FFFF0");
    });

    it("scrollToIndex lands on a row in the middle", () => {
      const ref = createRef<HexViewHandle>();
      render(<HexView data={sixteenMiB} ref={ref} {...size} />);
      act(() => ref.current!.scrollToIndex(0x123456));
      const addresses = rows().map(address);
      expect(addresses).toContain("123450");
    });

    it("reaches the end of a buffer past the scroll-height cap", () => {
      // 1M rows at 20 px is 21M px, over the 15M px cap.
      const ref = createRef<HexViewHandle>();
      render(<HexView data={sixteenMiB} ref={ref} {...size} />);
      act(() => ref.current!.scrollToIndex(sixteenMiB.length - 1));
      expect(address(lastRow())).toBe("FFFFF0");
    });
  });

  describe("decorateByte", () => {
    it("applies the decoration to the hex and ASCII cells", () => {
      const decorate = (index: number) =>
        index === 2 ? { className: "changed", title: "was 00" } : undefined;
      render(<HexView data={ascii("abcd")} decorateByte={decorate} {...size} />);

      const marked = document.querySelectorAll('[data-index="2"]');
      expect(marked).toHaveLength(2);
      for (const el of marked) {
        expect(el).toHaveClass("changed");
        expect(el).toHaveAttribute("title", "was 00");
      }
      expect(document.querySelectorAll(".changed")).toHaveLength(2);
    });

    it("is only called for bytes in rendered rows", () => {
      const decorate = vi.fn(() => undefined);
      render(
        <HexView data={ramp(1024 * 1024)} decorateByte={decorate} {...size} />,
      );
      expect(decorate.mock.calls.length).toBeLessThanOrEqual(24 * 16 * 2);
      expect(decorate).toHaveBeenCalledWith(0, 0);
    });
  });

  it("reports the byte index on click in either column", () => {
    const onByteClick = vi.fn();
    render(
      <HexView data={ramp(64)} onByteClick={onByteClick} {...size} />,
    );
    const row = rows()[1];
    fireEvent.click(cells(row)[0].querySelector('[data-index="18"]')!);
    fireEvent.click(cells(row)[1].querySelector('[data-index="19"]')!);
    expect(onByteClick.mock.calls.map(([i]) => i)).toEqual([18, 19]);
  });

  it("does not mutate the caller's buffer", () => {
    const data = ramp(64);
    const copy = data.slice();
    render(<HexView data={data} decorateByte={() => ({ className: "x" })} {...size} />);
    expect(data).toEqual(copy);
  });
});
