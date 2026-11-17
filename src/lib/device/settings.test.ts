import { describe, expect, it } from "vitest";
import { settingsStore } from "./settings";

function memoryStorage() {
  const stored = new Map<string, string>();
  return {
    stored,
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  };
}

describe("settingsStore", () => {
  it("remembers the algorithm file's path, and nothing when there is none", () => {
    const storage = memoryStorage();
    const settings = settingsStore(storage);
    expect(settings.loadAlgorithmPath()).toBeNull();
    settings.saveAlgorithmPath("/home/me/xgecu/algorithm.xml");
    expect(settingsStore(storage).loadAlgorithmPath()).toBe("/home/me/xgecu/algorithm.xml");
    // Only the path is kept.
    expect([...storage.stored.values()]).toEqual(["/home/me/xgecu/algorithm.xml"]);
    settings.saveAlgorithmPath(null);
    expect(settings.loadAlgorithmPath()).toBeNull();
    expect(storage.stored.size).toBe(0);
  });

  it("treats a blank value as no setting", () => {
    const storage = memoryStorage();
    storage.setItem("burnwright.algorithmPath", "  ");
    expect(settingsStore(storage).loadAlgorithmPath()).toBeNull();
  });

  it("carries on when the storage throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const settings = settingsStore(broken);
    expect(settings.loadAlgorithmPath()).toBeNull();
    expect(() => settings.saveAlgorithmPath("/x")).not.toThrow();
    expect(() => settings.saveAlgorithmPath(null)).not.toThrow();
  });
});
