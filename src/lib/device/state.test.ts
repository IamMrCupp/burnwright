import { describe, expect, it } from "vitest";
import { recentStore } from "./recent";
import {
  initialState,
  LOG_LIMIT,
  logText,
  reducer,
  RECENT_LIMIT,
  visibleRecent,
  type DeviceState,
} from "./state";

function running(state: DeviceState): DeviceState {
  return reducer(state, { type: "op_started", op: "write", chip: "X", heading: "Write X" });
}

describe("the scan of the buffer", () => {
  const report = {
    len: 4,
    findings: [
      {
        offset: 0,
        size: 4,
        kind: "gzip",
        description: "gzip compressed data",
        confidence: "high" as const,
      },
    ],
    entropy: { block: 256, millibits: [2000] },
  };
  const loaded = (bytes: Uint8Array) =>
    reducer(initialState(), {
      type: "buffer_loaded",
      bytes,
      source: { kind: "file", path: "/a.bin" },
    });

  it("goes from scanning to a report", () => {
    let state = loaded(Uint8Array.of(1, 2, 3, 4));
    expect(state.inspect).toBeNull();
    state = reducer(state, { type: "inspect_started", bytes: 4 });
    expect(state.inspect).toEqual({ status: "scanning", bytes: 4 });
    state = reducer(state, { type: "inspect_done", report, stale: false });
    expect(state.inspect).toEqual({ status: "done", report, stale: false });
  });

  it("marks a report stale once the buffer is edited, and keeps it", () => {
    const bytes = Uint8Array.of(1, 2, 3, 4);
    let state = loaded(bytes);
    state = reducer(state, { type: "inspect_done", report, stale: false });
    // The editor reporting the bytes it was given isn't an edit.
    state = reducer(state, { type: "buffer_edited", bytes, edited: false });
    expect(state.inspect).toMatchObject({ stale: false });
    state = reducer(state, {
      type: "buffer_edited",
      bytes: Uint8Array.of(9, 2, 3, 4),
      edited: true,
    });
    expect(state.inspect).toEqual({ status: "done", report, stale: true });
  });

  it("drops the report when other bytes are loaded", () => {
    let state = loaded(Uint8Array.of(1, 2, 3, 4));
    state = reducer(state, { type: "inspect_done", report, stale: false });
    state = reducer(state, {
      type: "buffer_loaded",
      bytes: Uint8Array.of(5),
      source: { kind: "chip", chip: "X" },
    });
    expect(state.inspect).toBeNull();
  });

  it("keeps a failure apart from a report with nothing in it", () => {
    let state = loaded(Uint8Array.of(1));
    state = reducer(state, { type: "inspect_failed", message: "signal: 6" });
    expect(state.inspect).toEqual({ status: "failed", message: "signal: 6" });
    state = reducer(state, { type: "inspect_cancelled" });
    expect(state.inspect).toEqual({ status: "cancelled" });
    state = reducer(state, { type: "inspect_closed" });
    expect(state.inspect).toBeNull();
    // Closing what's already closed changes nothing.
    expect(reducer(state, { type: "inspect_closed" })).toBe(state);
  });
});

describe("reducer", () => {
  it("follows minipro's stages and percentages", () => {
    let state = running(initialState());
    expect(state.running).toMatchObject({ stage: null, percent: null, phase: "main" });
    state = reducer(state, {
      type: "progress",
      event: { type: "stage_started", stage: "write", label: "Writing Code" },
    });
    state = reducer(state, {
      type: "progress",
      event: { type: "progress", stage: "write", percent: 40 },
    });
    expect(state.running).toMatchObject({ stage: "Writing Code", percent: 40 });
    const same = reducer(state, {
      type: "progress",
      event: { type: "progress", stage: "write", percent: 40 },
    });
    expect(same).toBe(state);
    state = reducer(state, {
      type: "progress",
      event: { type: "stage_finished", stage: "write", seconds: null },
    });
    expect(state.running?.percent).toBe(100);
    expect(logText(state.log)).toBe("== Write X ==\nWriting Code...\nWriting Code: done");
  });

  it("logs every kind of line minipro and burnwright produce", () => {
    let state = initialState();
    state = reducer(state, { type: "progress", event: { type: "command", line: "minipro -k" } });
    state = reducer(state, { type: "progress", event: { type: "info", message: "t48: T48" } });
    state = reducer(state, { type: "progress", event: { type: "warning", message: "Warning: x" } });
    state = reducer(state, { type: "progress", event: { type: "error", message: "Bad" } });
    state = reducer(state, { type: "logged", kind: "note", text: "Opened a.bin" });
    expect(state.log.map((line) => line.kind)).toEqual([
      "command",
      "output",
      "warning",
      "error",
      "note",
    ]);
    expect(new Set(state.log.map((line) => line.id)).size).toBe(5);
    expect(logText(state.log)).toBe("$ minipro -k\nt48: T48\nWarning: x\nBad\nOpened a.bin");
  });

  it("keeps the log bounded, dropping the oldest lines", () => {
    let state = initialState();
    for (let i = 0; i < LOG_LIMIT + 10; i++) {
      state = reducer(state, { type: "logged", kind: "note", text: `line ${i}` });
    }
    expect(state.log).toHaveLength(LOG_LIMIT);
    expect(state.log[0].text).toBe("line 10");
    expect(state.log[LOG_LIMIT - 1].text).toBe(`line ${LOG_LIMIT + 9}`);
  });

  it("starting an operation clears the last outcome, confirmation and diff", () => {
    let state = initialState();
    state = reducer(state, {
      type: "confirm_opened",
      confirm: {
        kind: "write",
        chip: "X",
        overrides: { ignoreChipId: false, ignoreSize: false },
      },
    });
    state = reducer(state, {
      type: "diff_opened",
      diff: { chip: "X", read: new Uint8Array(1), after: "verify" },
    });
    state = running(state);
    expect(state).toMatchObject({ outcome: null, confirm: null, diff: null });
  });

  it("keeps recent chips to a handful, and to the active programmer's list", () => {
    let state = initialState();
    for (let i = 0; i < RECENT_LIMIT + 3; i++) {
      state = reducer(state, {
        type: "chip_selected",
        chip: { name: `CHIP${i}`, package: null },
        programmer: i % 2 === 0 ? "t48" : "t76",
      });
    }
    expect(state.chip.recent).toHaveLength(RECENT_LIMIT);
    expect(state.chip.recent[0].name).toBe(`CHIP${RECENT_LIMIT + 2}`);
    // The T48 and the T56 read the same list; the T76 has its own.
    expect(visibleRecent(state).every((chip) => chip.programmer === "t48")).toBe(true);
    const onT56 = reducer(state, { type: "programmer_chosen", programmer: "t56" });
    expect(visibleRecent(onT56)).toEqual(visibleRecent(state));
    const onT76 = reducer(state, { type: "programmer_chosen", programmer: "t76" });
    expect(visibleRecent(onT76).every((chip) => chip.programmer === "t76")).toBe(true);
  });
});

describe("recent store", () => {
  function storageWith(value: string | null) {
    const stored = new Map<string, string>();
    if (value !== null) stored.set("burnwright.recentChips", value);
    return {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, v: string) => void stored.set(key, v),
    };
  }

  it("ignores anything that isn't a list of chips", () => {
    expect(recentStore(storageWith(null)).load()).toEqual([]);
    expect(recentStore(storageWith("not json")).load()).toEqual([]);
    expect(recentStore(storageWith('{"name":"X"}')).load()).toEqual([]);
    expect(
      recentStore(
        storageWith(
          JSON.stringify([
            { name: "A", package: null, programmer: "t48" },
            { name: "B", package: "SOIC8", programmer: "t999" },
            { name: "", package: null, programmer: "t48" },
            "C",
          ]),
        ),
      ).load(),
    ).toEqual([{ name: "A", package: null, programmer: "t48" }]);
  });

  it("survives a storage that throws", () => {
    const store = recentStore({
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("full");
      },
    });
    expect(store.load()).toEqual([]);
    expect(() => store.save([{ name: "A", package: null, programmer: "t48" }])).not.toThrow();
  });
});
