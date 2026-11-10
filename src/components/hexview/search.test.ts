import { describe, expect, it } from "vitest";
import {
  bytesToHexText,
  encodeAscii,
  findAll,
  findPattern,
  indexOfPattern,
  lastIndexOfPattern,
  parseAddress,
  parseHexPattern,
  parsePattern,
} from "./search";

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const bytesOf = (r: ReturnType<typeof parseHexPattern>) =>
  r.ok ? Array.from(r.bytes) : r.error;

describe("parseHexPattern", () => {
  it("accepts packed, spaced, comma-separated and 0x-prefixed hex", () => {
    expect(bytesOf(parseHexPattern("DEADbeef"))).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(bytesOf(parseHexPattern(" de ad\tbe\nef "))).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(bytesOf(parseHexPattern("0x01, 0x02,0X03"))).toEqual([1, 2, 3]);
  });

  it("rejects empty, odd-length and non-hex input", () => {
    expect(parseHexPattern("").ok).toBe(false);
    expect(parseHexPattern("   ").ok).toBe(false);
    expect(bytesOf(parseHexPattern("ABC"))).toMatch(/two digits/);
    expect(bytesOf(parseHexPattern("AG"))).toMatch(/“G”/);
  });
});

describe("encodeAscii", () => {
  it("encodes one byte per character, Latin-1 included", () => {
    expect(bytesOf(encodeAscii("Hié"))).toEqual([0x48, 0x69, 0xe9]);
  });

  it("rejects empty text and characters above U+00FF", () => {
    expect(encodeAscii("").ok).toBe(false);
    expect(bytesOf(encodeAscii("a€b"))).toMatch(/single-byte/);
  });

  it("is what parsePattern uses in ASCII mode", () => {
    expect(bytesOf(parsePattern("AB", "ascii"))).toEqual([0x41, 0x42]);
    expect(bytesOf(parsePattern("AB", "hex"))).toEqual([0xab]);
  });
});

it("bytesToHexText spaces uppercase pairs", () => {
  expect(bytesToHexText(Uint8Array.of(0, 0x0a, 0xff))).toBe("00 0A FF");
  expect(bytesToHexText(new Uint8Array(0))).toBe("");
});

describe("search", () => {
  const data = ascii("abcabcab");
  const abc = ascii("abc");

  it("finds forward and backward from a position", () => {
    expect(indexOfPattern(data, abc, 0)).toBe(0);
    expect(indexOfPattern(data, abc, 1)).toBe(3);
    expect(indexOfPattern(data, abc, 4)).toBe(-1);
    expect(lastIndexOfPattern(data, abc)).toBe(3);
    expect(lastIndexOfPattern(data, abc, 2)).toBe(0);
    expect(lastIndexOfPattern(data, abc, -1)).toBe(-1);
  });

  it("handles patterns longer than the data and the empty pattern", () => {
    expect(indexOfPattern(ascii("ab"), abc)).toBe(-1);
    expect(lastIndexOfPattern(ascii("ab"), abc)).toBe(-1);
    expect(indexOfPattern(data, new Uint8Array(0))).toBe(-1);
  });

  it("does not match a partial pattern at the end", () => {
    expect(indexOfPattern(ascii("xxab"), abc)).toBe(-1);
  });

  it("wraps round once, and says so", () => {
    expect(findPattern(data, abc, 4, "next")).toEqual({ index: 0, wrapped: true });
    expect(findPattern(data, abc, 1, "next")).toEqual({ index: 3, wrapped: false });
    expect(findPattern(data, abc, -1, "previous")).toEqual({ index: 3, wrapped: true });
    expect(findPattern(data, abc, 2, "previous")).toEqual({ index: 0, wrapped: false });
    expect(findPattern(data, ascii("zz"), 0, "next")).toBeNull();
    expect(findPattern(data, ascii("zz"), 7, "previous")).toBeNull();
  });

  it("finds the only match again when wrapping from just past it", () => {
    const one = ascii("..abc..");
    expect(findPattern(one, abc, 3, "next")).toEqual({ index: 2, wrapped: true });
    expect(findPattern(one, abc, 1, "previous")).toEqual({ index: 2, wrapped: true });
  });

  it("findAll returns non-overlapping matches, up to a limit", () => {
    expect(findAll(ascii("aaaa"), ascii("aa"))).toEqual([0, 2]);
    expect(findAll(data, abc)).toEqual([0, 3]);
    expect(findAll(new Uint8Array(100), Uint8Array.of(0), 5)).toHaveLength(5);
  });

  it("searches a 16 MiB buffer to a hit near the end", () => {
    const big = new Uint8Array(16 * 1024 * 1024).fill(0xff);
    big.set([0xde, 0xad, 0xbe, 0xef], big.length - 8);
    const needle = Uint8Array.of(0xde, 0xad, 0xbe, 0xef);
    expect(findPattern(big, needle, 0, "next")).toEqual({
      index: big.length - 8,
      wrapped: false,
    });
    expect(findPattern(big, Uint8Array.of(0x00), 0, "next")).toBeNull();
  });
});

describe("parseAddress", () => {
  it("reads hex with or without 0x, ignoring spaces and underscores", () => {
    expect(parseAddress("1F")).toBe(0x1f);
    expect(parseAddress(" 0x00ff_ff00 ")).toBe(0xffff00);
  });

  it("rejects anything that is not hex", () => {
    expect(parseAddress("")).toBeNull();
    expect(parseAddress("0x")).toBeNull();
    expect(parseAddress("12g")).toBeNull();
    expect(parseAddress("-1")).toBeNull();
  });
});
