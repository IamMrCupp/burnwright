import { describe, expect, it } from "vitest";
import {
  DEFAULT_STREAM_PORT,
  DEFAULT_STREAM_SETTINGS,
  isStreamPort,
  streamSettingsStore,
} from "./settings";

function memoryStorage(initial: Record<string, string> = {}) {
  const stored = new Map(Object.entries(initial));
  return {
    stored,
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  };
}

describe("streamSettingsStore", () => {
  it("is off until something is saved", () => {
    expect(streamSettingsStore(memoryStorage()).load()).toEqual({
      enabled: false,
      port: DEFAULT_STREAM_PORT,
      hidePaths: false,
    });
  });

  it("remembers the switch and the port", () => {
    const storage = memoryStorage();
    streamSettingsStore(storage).save({ enabled: true, port: 9001, hidePaths: false });
    expect(streamSettingsStore(storage).load()).toEqual({ enabled: true, port: 9001, hidePaths: false });
  });

  it("remembers that paths are hidden, and takes nothing but true for it", () => {
    const storage = memoryStorage();
    streamSettingsStore(storage).save({ enabled: false, port: 8790, hidePaths: true });
    expect(streamSettingsStore(storage).load()).toEqual({
      enabled: false,
      port: 8790,
      hidePaths: true,
    });
    // A setting saved before the switch existed.
    const older = memoryStorage({ "burnwright.stream": '{"enabled":true,"port":9001}' });
    expect(streamSettingsStore(older).load().hidePaths).toBe(false);
    const odd = memoryStorage({ "burnwright.stream": '{"hidePaths":"yes"}' });
    expect(streamSettingsStore(odd).load().hidePaths).toBe(false);
  });

  it("reads anything it can't make sense of as off", () => {
    for (const stored of ["", "{", "null", "7", '"on"', "[]", '{"enabled":"yes"}', '{"enabled":1}']) {
      const storage = memoryStorage({ "burnwright.stream": stored });
      expect(streamSettingsStore(storage).load().enabled, stored).toBe(false);
    }
  });

  it("falls back to the default port when the stored one can't be used", () => {
    for (const port of [80, 0, 70000, 8790.5, "8790", null]) {
      const storage = memoryStorage({
        "burnwright.stream": JSON.stringify({ enabled: true, port }),
      });
      expect(streamSettingsStore(storage).load()).toEqual({
        enabled: true,
        port: DEFAULT_STREAM_PORT,
        hidePaths: false,
      });
    }
  });

  it("survives a storage that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("no storage");
      },
      setItem: () => {
        throw new Error("no storage");
      },
    };
    const store = streamSettingsStore(broken);
    expect(store.load()).toEqual(DEFAULT_STREAM_SETTINGS);
    expect(() => store.save({ enabled: true, port: 9001, hidePaths: false })).not.toThrow();
  });
});

describe("isStreamPort", () => {
  it("takes whole numbers from 1024 to 65535", () => {
    expect([1024, 8790, 65535].every(isStreamPort)).toBe(true);
    expect([1023, 65536, 0, -1, 8790.5, NaN, "8790", null].some(isStreamPort)).toBe(false);
  });
});
