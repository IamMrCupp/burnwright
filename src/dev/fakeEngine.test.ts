import { describe, expect, it } from "vitest";
import type { InspectText } from "../lib/engine";
import { entropyOf, fakeScan, stringsOf } from "./fakeEngine";

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

// The same goes for its strings: these are the cases, and the answers, of
// the Rust tests in `crates/inspect/src/strings.rs`.
describe("stringsOf", () => {
  const enc = new TextEncoder();
  const ascii = (offset: number, text: string): InspectText => ({
    offset,
    chars: text.length,
    encoding: "ascii",
    text,
  });
  const wide = (offset: number, text: string): InspectText => ({
    ...ascii(offset, text),
    encoding: "utf16le",
  });
  const utf16 = (text: string) => Array.from(text, (c) => [c.charCodeAt(0), 0]).flat();
  /** `parts` laid end to end: a string is its bytes, a number one byte. */
  const dump = (...parts: (string | number | number[])[]) =>
    Uint8Array.from(
      parts.flatMap((part) => (typeof part === "string" ? [...enc.encode(part)] : part)),
    );
  const fill = (byte: number, count: number) => new Array<number>(count).fill(byte);
  /** One string of `chars` characters and the zero byte that ends it. */
  const line = (chars: number) => [...fill(0x61, chars), 0];
  const none = { min_chars: 4, total: 0, cut: false, found: [] };

  it("finds printable runs with their offsets", () => {
    const data = dump(fill(0xff, 16), "U-Boot 2019.07", fill(0, 6), "console=ttyS0,115200", fill(0xff, 4));
    expect(stringsOf(data)).toEqual({
      min_chars: 4,
      total: 2,
      cut: false,
      found: [ascii(16, "U-Boot 2019.07"), ascii(36, "console=ttyS0,115200")],
    });
  });

  it("wants four characters, and takes a string that fills or ends the dump", () => {
    expect(stringsOf(dump("abc", 0, "abcd", 0, "ab", 0xff, "x")).found).toEqual([ascii(4, "abcd")]);
    expect(stringsOf(dump("root")).found).toEqual([ascii(0, "root")]);
    expect(stringsOf(dump(0, 0, "admin")).found).toEqual([ascii(2, "admin")]);
    expect(stringsOf(dump("adm"))).toEqual(none);
  });

  it("ends a string at a line break, not at a tab, and at anything past ASCII", () => {
    expect(stringsOf(dump("first line\nsecond\tline\r\nend.")).found).toEqual([
      ascii(0, "first line"),
      ascii(11, "second\tline"),
      ascii(24, "end."),
    ]);
    expect(stringsOf(dump("caf", 0xe9, " au lait")).found).toEqual([ascii(4, " au lait")]);
    expect(stringsOf(dump(0x7f, "abcd", 0x7f)).found).toEqual([ascii(1, "abcd")]);
  });

  it("finds UTF-16 runs on even and odd offsets", () => {
    const even = dump(fill(0xff, 8), utf16("BIOS Setup"), fill(0xff, 8));
    expect(stringsOf(even).found).toEqual([wide(8, "BIOS Setup")]);
    const odd = dump(fill(0xff, 7), utf16("BIOS Setup"), fill(0xff, 8));
    expect(stringsOf(odd).found).toEqual([wide(7, "BIOS Setup")]);
    // Cut off before its last zero byte: three whole characters.
    expect(stringsOf(Uint8Array.from(utf16("abcd").slice(0, 7)))).toEqual(none);
  });

  it("lists both kinds in offset order, the one-byte string first on a tie", () => {
    const data = dump(utf16("Wide one"), fill(0xff, 3), "narrow one", fill(0xff, 3), utf16("Wide two"), 0xff, "narrow two");
    expect(stringsOf(data).found).toEqual([
      wide(0, "Wide one"),
      ascii(19, "narrow one"),
      wide(32, "Wide two"),
      ascii(49, "narrow two"),
    ]);
    // "ABCD", then "DEFG" with a zero after each letter: the D is in both.
    expect(stringsOf(dump("ABC", utf16("DEFG"))).found).toEqual([ascii(0, "ABCD"), wide(3, "DEFG")]);
  });

  it("has nothing to say about erased and empty dumps", () => {
    expect(stringsOf(new Uint8Array(0))).toEqual(none);
    expect(stringsOf(new Uint8Array(4096).fill(0xff))).toEqual(none);
    expect(stringsOf(new Uint8Array(4096))).toEqual(none);
    expect(stringsOf(Uint8Array.of(0x41))).toEqual(none);
  });

  it("cuts a long string at 120 characters and still says how long it was", () => {
    const { found } = stringsOf(dump(0, 0, "x".repeat(500), 0, 0, utf16("y".repeat(300))));
    expect(found).toEqual([
      { offset: 2, chars: 500, encoding: "ascii", text: "x".repeat(120) },
      { offset: 504, chars: 300, encoding: "utf16le", text: "y".repeat(120) },
    ]);
  });

  it("leaves out the shortest when there are too many", () => {
    // Six of 4 characters, four of 5, three of 9, shuffled together.
    const data = dump(...[4, 9, 4, 5, 4, 5, 9, 4, 5, 4, 5, 9, 4].map(line));
    const lengths = (limit: number) => {
      const { min_chars, total, cut, found } = stringsOf(data, limit);
      return { min_chars, total, cut, chars: found.map((text) => text.chars) };
    };
    expect(lengths(13)).toMatchObject({ min_chars: 4, total: 13, cut: false });
    expect(lengths(13).chars).toHaveLength(13);
    expect(lengths(7)).toEqual({ min_chars: 5, total: 13, cut: false, chars: [9, 5, 5, 9, 5, 5, 9] });
    // The rule goes to the first length that fits, and that isn't 9.
    expect(lengths(3)).toEqual({ min_chars: 6, total: 13, cut: false, chars: [9, 9, 9] });
  });

  it("never leaves a long string out for its length, only off the end", () => {
    // Fifty strings of 40 characters and room for twenty.
    const strings = stringsOf(dump(...Array.from({ length: 50 }, () => line(40))), 20);
    expect(strings).toMatchObject({ min_chars: 16, total: 50, cut: true });
    expect(strings.found.map((text) => text.offset)).toEqual(
      Array.from({ length: 20 }, (_, i) => i * 41),
    );
  });
});

describe("fakeScan", () => {
  it("reports the strings in what it was given", () => {
    const data = new Uint8Array(64).fill(0xff);
    data.set(new TextEncoder().encode("Linux-5.4.171"), 32);
    expect(fakeScan(data).strings).toEqual(stringsOf(data));
    expect(fakeScan(data).strings.found.map((text) => text.text)).toEqual(["Linux-5.4.171"]);
  });

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
