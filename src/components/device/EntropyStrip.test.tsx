import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EntropyStrip } from "./EntropyStrip";

const strip = () => screen.getByRole("slider", { name: "Entropy across the buffer" });
const press = (key: string) => fireEvent.keyDown(strip(), { key });
/** Give the strip a place on the page: jsdom lays nothing out. */
function place(left: number, width: number) {
  strip().getBoundingClientRect = () => ({ left, width }) as DOMRect;
}

describe("EntropyStrip", () => {
  const entropy = { block: 4096, millibits: [0, 0, 7950, 7990, 4200, 0, 0, 0] };
  const len = 8 * 4096;

  it("draws nothing for a dump with no blocks", () => {
    const { container } = render(
      <EntropyStrip entropy={{ block: 256, millibits: [] }} len={0} onJump={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("draws every block and says how much of the buffer is flat", () => {
    const { container } = render(<EntropyStrip entropy={entropy} len={len} onJump={vi.fn()} />);
    expect(container.querySelector("svg")).toHaveAttribute("viewBox", "0 0 8 8000");
    expect(container.querySelector("path")).toHaveAttribute(
      "d",
      "M0,8000V8000H2V50H3V10H4V3800H5V8000H8V8000Z",
    );
    expect(container).toHaveTextContent("Entropy of each 4 KiB, from 0 to 8 bits a byte.");
    expect(container).toHaveTextContent("63% of the buffer is flat, the way erased flash reads.");
    // Nothing is marked until it's pointed at.
    expect(container.querySelector("line")).toBeNull();
  });

  it("says nothing about flat when none of it is, and all when all of it is", () => {
    const { container, rerender } = render(
      <EntropyStrip entropy={{ block: 256, millibits: [7000, 6500] }} len={512} onJump={vi.fn()} />,
    );
    expect(container).not.toHaveTextContent("flat");
    rerender(<EntropyStrip entropy={{ block: 256, millibits: [0, 0] }} len={512} onJump={vi.fn()} />);
    expect(container).toHaveTextContent("All of the buffer is flat, the way erased flash reads.");
  });

  it("reads out the block the pointer is over, and a click goes to it", () => {
    const onJump = vi.fn();
    const { container } = render(<EntropyStrip entropy={entropy} len={len} onJump={onJump} />);
    place(40, 800);
    fireEvent.mouseMove(strip(), { clientX: 40 + 250 });
    expect(screen.getByText("0x00002000, 7.95 bits a byte")).toBeInTheDocument();
    expect(container.querySelector("line")).toHaveAttribute("x1", "2.5");
    expect(onJump).not.toHaveBeenCalled();

    fireEvent.click(strip(), { clientX: 40 + 450 });
    expect(onJump).toHaveBeenCalledExactlyOnceWith(0x4000);
    expect(screen.getByText("0x00004000, 4.20 bits a byte")).toBeInTheDocument();
    // The readout stays where the click went once the pointer has gone.
    fireEvent.mouseLeave(strip());
    expect(screen.getByText("0x00004000, 4.20 bits a byte")).toBeInTheDocument();

    // Off either end is the block at that end.
    fireEvent.click(strip(), { clientX: 5 });
    expect(onJump).toHaveBeenLastCalledWith(0);
    fireEvent.click(strip(), { clientX: 5000 });
    expect(onJump).toHaveBeenLastCalledWith(7 * 4096);
  });

  it("steps along with the keyboard, and Enter goes to the block", () => {
    const onJump = vi.fn();
    render(<EntropyStrip entropy={entropy} len={len} onJump={onJump} />);
    expect(strip()).toHaveAttribute("tabindex", "0");
    expect(strip()).toHaveAttribute("aria-valuemin", "0");
    expect(strip()).toHaveAttribute("aria-valuemax", "7");
    expect(strip()).toHaveAttribute("aria-valuenow", "0");

    // The first step lands on the first block.
    press("ArrowRight");
    expect(strip()).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByText("0x00000000, 0.00 bits a byte")).toBeInTheDocument();
    press("ArrowRight");
    press("ArrowRight");
    expect(strip()).toHaveAttribute("aria-valuenow", "2");
    expect(strip()).toHaveAttribute("aria-valuetext", "0x00002000, 7.95 bits a byte");
    press("ArrowLeft");
    expect(strip()).toHaveAttribute("aria-valuenow", "1");
    press("End");
    expect(strip()).toHaveAttribute("aria-valuenow", "7");
    press("ArrowRight");
    expect(strip()).toHaveAttribute("aria-valuenow", "7");
    press("Home");
    press("ArrowLeft");
    expect(strip()).toHaveAttribute("aria-valuenow", "0");
    expect(onJump).not.toHaveBeenCalled();

    press("End");
    press("PageDown");
    press("Enter");
    expect(onJump).toHaveBeenCalledExactlyOnceWith(6 * 4096);
    press("PageUp");
    press(" ");
    expect(onJump).toHaveBeenLastCalledWith(7 * 4096);
    // A key that isn't its own is left alone.
    expect(fireEvent.keyDown(strip(), { key: "Tab" })).toBe(true);
    expect(fireEvent.keyDown(strip(), { key: "End" })).toBe(false);
  });

  it("takes strides of a sixteenth on a long strip", () => {
    const long = { block: 4096, millibits: new Array<number>(1024).fill(5000) };
    render(<EntropyStrip entropy={long} len={1024 * 4096} onJump={vi.fn()} />);
    press("PageUp");
    expect(strip()).toHaveAttribute("aria-valuenow", "64");
    press("PageUp");
    press("PageDown");
    expect(strip()).toHaveAttribute("aria-valuenow", "64");
  });

  it("holds its mark inside a shorter report", () => {
    const { rerender } = render(<EntropyStrip entropy={entropy} len={len} onJump={vi.fn()} />);
    press("End");
    expect(strip()).toHaveAttribute("aria-valuenow", "7");
    rerender(
      <EntropyStrip entropy={{ block: 256, millibits: [1000, 3000] }} len={512} onJump={vi.fn()} />,
    );
    expect(strip()).toHaveAttribute("aria-valuemax", "1");
    expect(strip()).toHaveAttribute("aria-valuenow", "1");
    expect(strip()).toHaveAttribute("aria-valuetext", "0x00000100, 3.00 bits a byte");
  });
});
