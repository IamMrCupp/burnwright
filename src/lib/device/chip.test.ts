import { describe, expect, it } from "vitest";
import { fakeChip } from "../../dev/fakeEngine";
import type { ChipInfo } from "../engine";
import {
  availabilityWarning,
  checkSize,
  chipListOf,
  isSizeMismatch,
  memoryDescription,
  memorySummary,
  sizeCheckText,
  socketDescription,
} from "./chip";
import {
  fileName,
  formatByteCount,
  formatSize,
  formatSizeWithBytes,
  joinList,
  sentence,
} from "./format";

const flash = fakeChip("W25Q32BV@SOIC8", 4_194_304);
const pld: ChipInfo = {
  ...fakeChip("GAL16V8D", 0),
  memory: { size: 2194, unit: "bits", bytes: null, data_sizes: [] },
};
const nand: ChipInfo = {
  ...fakeChip("DS35M2GB(x4)@SOP16", 0),
  memory: { size: 0, unit: "bytes", bytes: null, data_sizes: [131_102] },
};
const logic: ChipInfo = {
  ...fakeChip("7400", 0),
  kind: "logic",
  available_on: [],
  memory: null,
};

describe("format", () => {
  it("prints sizes exactly", () => {
    expect(formatByteCount(1)).toBe("1 byte");
    expect(formatByteCount(4_194_304)).toBe("4,194,304 bytes");
    expect(formatSize(4_194_304)).toBe("4 MiB");
    expect(formatSize(32_768)).toBe("32 KiB");
    expect(formatSize(1024 ** 3 * 2)).toBe("2 GiB");
    expect(formatSize(138_412_032)).toBe("132 MiB");
    expect(formatSize(131_102 * 1024)).toBe("131,102 KiB");
    // Not a whole number of KiB: stays in bytes, not rounded.
    expect(formatSize(1000)).toBe("1,000 bytes");
    expect(formatSize(256)).toBe("256 bytes");
    expect(formatSizeWithBytes(4_194_304)).toBe("4 MiB (4,194,304 bytes)");
    expect(formatSizeWithBytes(256)).toBe("256 bytes");
  });

  it("names files and joins lists", () => {
    expect(fileName("/home/me/rom.bin")).toBe("rom.bin");
    expect(fileName("C:\\dumps\\rom.hex")).toBe("rom.hex");
    expect(fileName("rom.bin")).toBe("rom.bin");
    expect(joinList([3])).toBe("3");
    expect(joinList([3, 17])).toBe("3 and 17");
    expect(joinList(["a", "b", "c"])).toBe("a, b and c");
    expect(sentence("the image is 10 bytes")).toBe("The image is 10 bytes.");
    expect(sentence("Overcurrent protection!")).toBe("Overcurrent protection!");
  });
});

describe("chip details", () => {
  it("sums up a chip's memory for a search result", () => {
    expect(memorySummary(flash)).toBe("4 MiB");
    expect(memorySummary(pld)).toBe("2,194 bits");
    expect(memorySummary(nand)).toBe("size not given");
    expect(memorySummary(logic)).toBe("logic IC");
  });

  it("describes a chip's memory in full", () => {
    expect(memoryDescription(flash.memory!)).toBe("4 MiB (4,194,304 bytes)");
    expect(
      memoryDescription({ size: 32_768, unit: "bytes", bytes: 32_768, data_sizes: [1024] }),
    ).toBe("32 KiB (32,768 bytes), plus 1,024 bytes of data memory");
    expect(
      memoryDescription({ size: 2_097_152, unit: "words", bytes: 4_194_304, data_sizes: [] }),
    ).toBe("2,097,152 words: 4 MiB (4,194,304 bytes)");
    expect(memoryDescription(pld.memory!)).toBe(
      "2,194 bits (a fuse map, not a byte image)",
    );
    expect(memoryDescription(nand.memory!)).toBe(
      "minipro doesn't give a size, plus 131,102 bytes of data memory",
    );
  });

  it("says how the chip goes on the programmer", () => {
    expect(socketDescription(fakeChip("AT28C256", 32_768, { socket: { kind: "dip", pins: 28 } }))).toBe(
      "Straight into the ZIF socket (28 pins).",
    );
    expect(socketDescription(flash)).toBe(
      "In the ZIF socket through a plain SOIC8 to DIP adapter (8 pins).",
    );
    expect(
      socketDescription({ ...flash, socket: { kind: "adapter", image: "Adapter008.JPG" } }),
    ).toBe(
      "Needs XGecu adapter 008 (Adapter008.JPG in Xgpro's files; burnwright doesn't ship the picture).",
    );
    expect(socketDescription({ ...flash, socket: { kind: "icsp_only" } })).toBe(
      "In-circuit programming only: it doesn't go in the socket.",
    );
    expect(socketDescription({ ...flash, socket: { kind: "other", text: "PLCC32" } })).toBe(
      "PLCC32",
    );
    expect(socketDescription({ ...flash, socket: null })).toBeNull();
  });

  it("warns when the programmer isn't one minipro lists for the chip", () => {
    const t56Only = { ...flash, available_on: ["t56" as const] };
    expect(availabilityWarning(t56Only, "t48")).toBe(
      "minipro lists W25Q32BV@SOIC8 for the T56, not the T48. It won't stop you, but the operation may fail or misbehave.",
    );
    expect(availabilityWarning(t56Only, "t56")).toBeNull();
    // minipro didn't say: no warning to give.
    expect(availabilityWarning(logic, "t48")).toBeNull();
  });

  it("groups the programmers that share a chip list", () => {
    expect(chipListOf("t48")).toBe("tl866ii");
    expect(chipListOf("t56")).toBe("tl866ii");
    expect(chipListOf("tl866ii")).toBe("tl866ii");
    expect(chipListOf("tl866a")).toBe("tl866a");
    expect(chipListOf("t76")).toBe("t76");
  });
});

describe("size check", () => {
  it("compares the buffer with the chip's image size", () => {
    expect(checkSize(null, flash)).toEqual({ status: "none" });
    expect(checkSize(16, null)).toEqual({ status: "none" });
    expect(checkSize(4_194_304, flash)).toEqual({ status: "match", bytes: 4_194_304 });
    expect(checkSize(1024, flash)).toEqual({ status: "short", buffer: 1024, chip: 4_194_304 });
    expect(checkSize(8_388_608, flash)).toEqual({
      status: "long",
      buffer: 8_388_608,
      chip: 4_194_304,
    });
    expect(isSizeMismatch(checkSize(1024, flash))).toBe(true);
    expect(isSizeMismatch(checkSize(4_194_304, flash))).toBe(false);
  });

  it("doesn't pretend to have checked a chip with no byte size", () => {
    expect(checkSize(1024, pld)).toEqual({ status: "unknown", why: "bits" });
    expect(checkSize(1024, nand)).toEqual({ status: "unknown", why: "not_given" });
    expect(checkSize(1024, logic)).toEqual({ status: "no_memory" });
    expect(isSizeMismatch(checkSize(1024, pld))).toBe(false);
    expect(sizeCheckText(checkSize(1024, pld), "GAL16V8D")).toMatch(
      /^Size not checked: GAL16V8D is a PLD/,
    );
    expect(sizeCheckText(checkSize(1024, nand), "DS35M2GB(x4)@SOP16")).toMatch(
      /^Size not checked: minipro gives no image size for DS35M2GB\(x4\)@SOP16/,
    );
  });

  it("words the comparison for the buffer panel", () => {
    expect(sizeCheckText(checkSize(4_194_304, flash), flash.name)).toBe(
      "Same size as W25Q32BV@SOIC8.",
    );
    expect(sizeCheckText(checkSize(4_194_303, flash), flash.name)).toBe(
      "1 byte smaller than W25Q32BV@SOIC8, which holds 4,194,304 bytes.",
    );
    expect(sizeCheckText(checkSize(4_194_560, flash), flash.name)).toBe(
      "256 bytes bigger than W25Q32BV@SOIC8, which holds 4,194,304 bytes.",
    );
    expect(sizeCheckText({ status: "none" }, flash.name)).toBeNull();
  });
});
