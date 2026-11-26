import { describe, expect, it } from "vitest";
import type { InspectStrings, InspectText } from "../engine";
import { filterStrings, formatStringCount, leftOut } from "./strings";

const text = (offset: number, value: string): InspectText => ({
  offset,
  chars: value.length,
  encoding: "ascii",
  text: value,
});

describe("filterStrings", () => {
  const found = [
    text(0, "U-Boot 2019.07"),
    text(64, "console=ttyS0,115200 root=/dev/mtdblock2"),
    text(200, "Root password:"),
    text(300, "nvram_get"),
  ];

  it("gives every string back, as the same array, for an empty filter", () => {
    expect(filterStrings(found, "")).toBe(found);
  });

  it("matches anywhere in a string, whatever the case", () => {
    expect(filterStrings(found, "root")).toEqual([found[1], found[2]]);
    expect(filterStrings(found, "BOOT")).toEqual([found[0]]);
    expect(filterStrings(found, "nvram_get")).toEqual([found[3]]);
  });

  it("counts a space as part of what's looked for", () => {
    expect(filterStrings(found, " root")).toEqual([found[1]]);
    expect(filterStrings(found, "root ")).toEqual([found[2]]);
  });

  it("takes a filter as text, not as a pattern", () => {
    expect(filterStrings(found, ".*")).toEqual([]);
    expect(filterStrings(found, "2019.07")).toEqual([found[0]]);
  });

  it("finds nothing when nothing matches", () => {
    expect(filterStrings(found, "squashfs")).toEqual([]);
  });
});

describe("leftOut", () => {
  const strings = (over: Partial<InspectStrings>, listed: number): InspectStrings => ({
    min_chars: 4,
    total: listed,
    cut: false,
    found: Array.from({ length: listed }, (_, i) => text(i * 16, "abcdefgh")),
    ...over,
  });

  it("says nothing when the list is all of them", () => {
    expect(leftOut(strings({}, 0))).toBeNull();
    expect(leftOut(strings({}, 31))).toBeNull();
  });

  it("says which were left out when the shortest had to go", () => {
    expect(leftOut(strings({ min_chars: 8, total: 829012 }, 1657))).toBe(
      "829,012 strings in all, too many to list. The ones shorter than 8 characters are left out, which leaves 1,657.",
    );
  });

  it("says the list stops short when dropping the shortest wasn't enough", () => {
    expect(leftOut(strings({ min_chars: 16, total: 1315860, cut: true }, 2000))).toBe(
      "1,315,860 strings in all, too many to list. The ones shorter than 16 characters are left out, and the list still stops at the first 2,000.",
    );
  });

  it("says the list stops short when nothing shorter was dropped", () => {
    expect(leftOut(strings({ total: 90, cut: true }, 40))).toBe(
      "90 strings in all, too many to list. The list stops at the first 40.",
    );
  });
});

describe("formatStringCount", () => {
  it("counts in words", () => {
    expect(formatStringCount(0)).toBe("0 strings");
    expect(formatStringCount(1)).toBe("1 string");
    expect(formatStringCount(16573)).toBe("16,573 strings");
  });
});
