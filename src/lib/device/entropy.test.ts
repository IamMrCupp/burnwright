import { describe, expect, it } from "vitest";
import { ENTROPY_MAX, blockAt, entropyPath, flatBytes, formatBits, formatShare } from "./entropy";

describe("formatBits", () => {
  it("prints thousandths of a bit as bits to two places", () => {
    expect(formatBits(0)).toBe("0.00");
    expect(formatBits(811)).toBe("0.81");
    expect(formatBits(7943)).toBe("7.94");
    expect(formatBits(8000)).toBe("8.00");
  });
});

describe("entropyPath", () => {
  it("is empty for a dump with no blocks", () => {
    expect(entropyPath([])).toBe("");
  });

  it("draws one step for each block, zero at the bottom", () => {
    expect(entropyPath([0, 4000, 8000])).toBe("M0,8000V8000H1V4000H2V0H3V8000Z");
  });

  it("runs blocks at one level together", () => {
    expect(entropyPath([0, 0, 0, 8000, 8000, 2000])).toBe("M0,8000V8000H3V0H5V6000H6V8000Z");
    expect(entropyPath(new Array<number>(1024).fill(0))).toBe("M0,8000V8000H1024V8000Z");
  });

  it("keeps a value off the scale inside the strip", () => {
    expect(entropyPath([9000, -5])).toBe(`M0,${ENTROPY_MAX}V0H1V${ENTROPY_MAX}H2V${ENTROPY_MAX}Z`);
  });
});

describe("blockAt", () => {
  it("picks the block a point along the strip is in", () => {
    expect(blockAt(0, 4)).toBe(0);
    expect(blockAt(0.24, 4)).toBe(0);
    expect(blockAt(0.25, 4)).toBe(1);
    expect(blockAt(0.99, 4)).toBe(3);
    expect(blockAt(0.5, 1024)).toBe(512);
  });

  it("holds a point off either end to the block at that end", () => {
    expect(blockAt(-0.2, 4)).toBe(0);
    expect(blockAt(1, 4)).toBe(3);
    expect(blockAt(7, 4)).toBe(3);
    expect(blockAt(Number.NaN, 4)).toBe(0);
  });
});

describe("flatBytes", () => {
  it("counts the bytes in blocks with no entropy", () => {
    expect(flatBytes({ block: 256, millibits: [0, 5000, 0, 0] }, 1024)).toBe(768);
    expect(flatBytes({ block: 256, millibits: [1, 8000] }, 512)).toBe(0);
    expect(flatBytes({ block: 256, millibits: [] }, 0)).toBe(0);
  });

  it("counts a short last block for the bytes it has", () => {
    expect(flatBytes({ block: 256, millibits: [3000, 0] }, 300)).toBe(44);
    expect(flatBytes({ block: 256, millibits: [0] }, 10)).toBe(10);
  });
});

describe("formatShare", () => {
  it("says none and all only when they're exact", () => {
    expect(formatShare(0, 1000)).toBe("none");
    expect(formatShare(1000, 1000)).toBe("all");
    expect(formatShare(1, 1000)).toBe("under 1%");
    expect(formatShare(999, 1000)).toBe("over 99%");
    expect(formatShare(0, 0)).toBe("none");
  });

  it("is a whole percentage in between", () => {
    expect(formatShare(768, 1024)).toBe("75%");
    expect(formatShare(1, 3)).toBe("33%");
    expect(formatShare(10, 1000)).toBe("1%");
    expect(formatShare(990, 1000)).toBe("99%");
  });
});
