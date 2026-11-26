import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { InspectStrings, InspectText } from "../../lib/engine";
import { StringsList } from "./StringsList";

const ascii = (offset: number, text: string): InspectText => ({
  offset,
  chars: text.length,
  encoding: "ascii",
  text,
});

const strings = (found: InspectText[], over: Partial<InspectStrings> = {}): InspectStrings => ({
  min_chars: 4,
  total: found.length,
  cut: false,
  found,
  ...over,
});

const FOUND = [
  ascii(0x8000, "U-Boot 2019.07"),
  ascii(0x8040, "bootargs=console=ttyS0,115200 root=/dev/mtdblock2"),
  { ...ascii(0x9000, "Setup Utility"), encoding: "utf16le" as const },
  ascii(0x2f0000, "admin_user=root"),
];

const filter = () => screen.getByRole("searchbox", { name: "Filter strings" });
const type = (value: string) => fireEvent.change(filter(), { target: { value } });
const rows = () => within(screen.getByRole("table", { name: "Strings" })).getAllByRole("row").slice(1);

describe("StringsList", () => {
  it("says so when the dump has no text in it", () => {
    render(<StringsList strings={strings([])} covered={false} onJump={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "No text of 4 characters or more in these bytes.",
    );
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("lists each string with its offset and length", () => {
    render(<StringsList strings={strings(FOUND)} covered={false} onJump={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "4 strings. Pick one to go to it in the buffer.",
    );
    expect(rows().map((row) => row.textContent)).toEqual([
      "0x0000800014U-Boot 2019.07",
      "0x0000804049bootargs=console=ttyS0,115200 root=/dev/mtdblock2",
      "0x0000900013UTF-16Setup Utility",
      "0x002F000015admin_user=root",
    ]);
  });

  it("goes to a string from its row or its offset", () => {
    const onJump = vi.fn();
    render(<StringsList strings={strings(FOUND)} covered={false} onJump={onJump} />);
    fireEvent.click(screen.getByText("U-Boot 2019.07"));
    expect(onJump).toHaveBeenLastCalledWith(0x8000);
    fireEvent.click(screen.getByRole("button", { name: "Go to 0x002F0000, admin_user=root" }));
    expect(onJump).toHaveBeenLastCalledWith(0x2f0000);
    expect(onJump).toHaveBeenCalledTimes(2);
  });

  it("narrows the list to what the filter is in, whatever its case", () => {
    render(<StringsList strings={strings(FOUND)} covered={false} onJump={vi.fn()} />);
    type("ROOT");
    expect(rows()).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent(
      "2 of 4 strings with “ROOT” in them.",
    );
    type("u-boot");
    expect(rows()).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent(
      "1 of 4 strings with “u-boot” in it.",
    );
    type("");
    expect(rows()).toHaveLength(4);
  });

  it("says nothing matches, and keeps the filter to change", () => {
    render(<StringsList strings={strings(FOUND)} covered={false} onJump={vi.fn()} />);
    type("squashfs");
    expect(screen.getByRole("status")).toHaveTextContent(
      "0 of 4 strings with “squashfs” in them.",
    );
    expect(screen.queryByRole("table")).toBeNull();
    expect(filter()).toHaveValue("squashfs");
  });

  it("marks a string longer than what was kept of it", () => {
    const long = { offset: 16, chars: 500, encoding: "ascii" as const, text: "x".repeat(120) };
    render(<StringsList strings={strings([long])} covered={false} onJump={vi.fn()} />);
    expect(rows()[0]).toHaveTextContent(`0x00000010500${"x".repeat(120)}…`);
    expect(screen.getByTitle("The first 120 of 500 characters")).toBeInTheDocument();
  });

  it("keeps a string's own spaces", () => {
    render(
      <StringsList strings={strings([ascii(0, "  two  spaces\tand a tab ")])} covered={false} onJump={vi.fn()} />,
    );
    expect(document.querySelector(".strings-text code")?.textContent).toBe(
      "  two  spaces\tand a tab ",
    );
  });

  it("draws the first 500 and points at the filter for the rest", () => {
    const many = Array.from({ length: 620 }, (_, i) => ascii(i * 16, `line ${i} of the log`));
    render(<StringsList strings={strings(many)} covered={false} onJump={vi.fn()} />);
    expect(rows()).toHaveLength(500);
    expect(screen.getByText("Showing the first 500 of 620. Filter to get at the rest.")).toBeInTheDocument();
    // The filter looks through all of them, not the 500 drawn.
    type("line 619");
    expect(rows()).toHaveLength(1);
    expect(screen.queryByText(/Showing the first/)).toBeNull();
    type("line");
    expect(screen.getByText("Showing the first 500 of 620. A longer filter narrows it down.")).toBeInTheDocument();
  });

  it("says what the scanner left out", () => {
    render(
      <StringsList
        strings={strings(FOUND, { min_chars: 8, total: 829012 })}
        covered={false}
        onJump={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        "829,012 strings in all, too many to list. The ones shorter than 8 characters are left out, which leaves 4.",
      ),
    ).toBeInTheDocument();
  });

  it("counts the strings and draws none of them when covered", () => {
    const { container } = render(<StringsList strings={strings(FOUND)} covered onJump={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "4 strings, covered while “Hide file paths in this window” is on.",
    );
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
    for (const text of FOUND) expect(container).not.toHaveTextContent(text.text);
  });

  it("shows them again once it's uncovered", () => {
    const view = render(<StringsList strings={strings(FOUND)} covered onJump={vi.fn()} />);
    view.rerender(<StringsList strings={strings(FOUND)} covered={false} onJump={vi.fn()} />);
    expect(rows()).toHaveLength(4);
  });
});
