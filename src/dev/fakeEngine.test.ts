import { describe, expect, it } from "vitest";
import { entropyOf, fakeScan } from "./fakeEngine";

// The pretend scan's entropy is the real sum, so these are the figures the
// Rust tests in `crates/inspect/src/entropy.rs` hold the scanner to.
describe("entropyOf", () => {
  const cycle = (length: number, values: number) =>
    Uint8Array.from({ length }, (_, i) => i % values);

  it("is nothing for one value over and over", () => {
    expect(entropyOf(new Uint8Array(4096).fill(0xff))).toEqual({
      block: 256,
      millibits: new Array(16).fill(0),
    });
    expect(entropyOf(Uint8Array.of(0x5a)).millibits).toEqual([0]);
  });

  it("is exact for equal shares of 2, 16 and 256 values", () => {
    expect(entropyOf(cycle(256, 2)).millibits).toEqual([1000]);
    expect(entropyOf(cycle(256, 16)).millibits).toEqual([4000]);
    expect(entropyOf(cycle(256, 256)).millibits).toEqual([8000]);
  });

  it("is 811 for three of one value to one of another", () => {
    const data = Uint8Array.from({ length: 256 }, (_, i) => (i % 4 === 0 ? 1 : 0));
    expect(entropyOf(data).millibits).toEqual([811]);
  });

  it("cuts a dump into at most 1,024 blocks of at least 256 bytes", () => {
    const KIB = 1024;
    const blocks = (len: number) => {
      const { block, millibits } = entropyOf(new Uint8Array(len));
      return [block, millibits.length];
    };
    expect(blocks(0)).toEqual([256, 0]);
    expect(blocks(1)).toEqual([256, 1]);
    expect(blocks(256 * KIB)).toEqual([256, 1024]);
    expect(blocks(256 * KIB + 1)).toEqual([512, 513]);
    expect(blocks(4 * KIB * KIB)).toEqual([4 * KIB, 1024]);
    expect(blocks(4 * KIB * KIB + 1)).toEqual([8 * KIB, 513]);
  });

  it("measures a short last block over the bytes it has", () => {
    const data = new Uint8Array(258).fill(0xff);
    data[256] = 0;
    data[257] = 1;
    expect(entropyOf(data).millibits).toEqual([0, 1000]);
  });
});

describe("fakeScan", () => {
  it("reports the entropy of what it was given", () => {
    const data = new Uint8Array(512).fill(0xff);
    data.set([0x1f, 0x8b, 0x08, 0x00], 256);
    const report = fakeScan(data);
    expect(report.findings.map((finding) => finding.offset)).toEqual([256]);
    expect(report.entropy).toEqual(entropyOf(data));
    expect(report.entropy.millibits[0]).toBe(0);
    expect(report.entropy.millibits[1]).toBeGreaterThan(0);
  });
});
