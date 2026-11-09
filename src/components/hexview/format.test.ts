import { describe, expect, it } from "vitest";
import {
  addressDigitsFor,
  byteToAscii,
  byteToHex,
  formatAddress,
} from "./format";

describe("byteToHex", () => {
  it("pads to two uppercase digits", () => {
    expect(byteToHex(0x00)).toBe("00");
    expect(byteToHex(0x0a)).toBe("0A");
    expect(byteToHex(0xff)).toBe("FF");
  });
});

describe("byteToAscii", () => {
  it("shows printable ASCII as itself", () => {
    expect(byteToAscii(0x20)).toBe(" ");
    expect(byteToAscii(0x41)).toBe("A");
    expect(byteToAscii(0x7e)).toBe("~");
  });

  it("shows control and high bytes as a dot", () => {
    expect(byteToAscii(0x00)).toBe(".");
    expect(byteToAscii(0x1f)).toBe(".");
    expect(byteToAscii(0x7f)).toBe(".");
    expect(byteToAscii(0xff)).toBe(".");
  });
});

describe("formatAddress", () => {
  it("zero-pads uppercase hex to the given width", () => {
    expect(formatAddress(0, 4)).toBe("0000");
    expect(formatAddress(0x1f0, 4)).toBe("01F0");
    expect(formatAddress(0xdeadbeef, 8)).toBe("DEADBEEF");
  });

  it("never truncates an address wider than the width", () => {
    expect(formatAddress(0x12345, 4)).toBe("12345");
  });

  it("rejects negative and non-integer addresses", () => {
    expect(() => formatAddress(-1, 4)).toThrow(RangeError);
    expect(() => formatAddress(1.5, 4)).toThrow(RangeError);
  });
});

describe("addressDigitsFor", () => {
  it("uses the minimum for small buffers", () => {
    expect(addressDigitsFor(0)).toBe(4);
    expect(addressDigitsFor(256)).toBe(4);
    expect(addressDigitsFor(0x10000)).toBe(4); // last address is FFFF
  });

  it("widens to fit the last address, rounded up to an even count", () => {
    expect(addressDigitsFor(0x10001)).toBe(6); // 10000 → 5 digits → 6
    expect(addressDigitsFor(16 * 1024 * 1024)).toBe(6); // FFFFFF
    expect(addressDigitsFor(16 * 1024 * 1024 + 1)).toBe(8);
  });

  it("accounts for the base address", () => {
    expect(addressDigitsFor(16, 0x0800_0000)).toBe(8);
  });

  it("honours a larger minimum", () => {
    expect(addressDigitsFor(16, 0, 8)).toBe(8);
  });
});
