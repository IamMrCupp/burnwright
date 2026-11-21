import { describe, expect, it } from "vitest";
import { initialState, type DeviceState } from "../device/state";
import { streamStatus } from "./status";
// The same file the Rust side's tests read: what one sends, the other takes.
import fixture from "../../../src-tauri/src/stream/status.fixture.json?raw";

const SECRET_PATH = "/home/me/customers/jane-doe/bios-dump.bin";

/** A device screen with something private in every place that can hold it. */
function busyState(): DeviceState {
  const state = initialState([{ name: "AT28C256", package: null, programmer: "t48" }]);
  return {
    ...state,
    programmer: {
      ...state.programmer,
      status: "found",
      device: {
        programmer: "T48",
        firmware: "01.1.32",
        chip: null,
        firmware_status: null,
        firmware_expected: null,
        support_warning: "T48 support is not yet complete!",
      },
    },
    algorithms: { status: "found", path: "/home/me/xgecu/algorithm.xml" } as never,
    chip: {
      ...state.chip,
      query: "w25q",
      selected: { name: "W25Q32BV@SOIC8", package: "SOIC8" },
    },
    buffer: {
      original: Uint8Array.of(0xde, 0xad, 0xbe, 0xef),
      bytes: Uint8Array.of(0xde, 0xad, 0xbe, 0xef),
      edited: false,
      saved: Uint8Array.of(0xde, 0xad, 0xbe, 0xef),
      source: { kind: "file", path: SECRET_PATH },
      path: SECRET_PATH,
    },
    fileError: `Couldn't open ${SECRET_PATH}`,
    running: {
      op: "write",
      chip: "W25Q32BV@SOIC8",
      phase: "main",
      stage: "Writing Code",
      percent: 40,
      cancelling: false,
    },
    outcome: {
      op: "verify",
      chip: "W25Q32BV@SOIC8",
      tone: "error",
      title: "Verify failed",
      details: [`${SECRET_PATH} differs from the chip at 0x40`],
      retry: null,
    },
    diff: { chip: "W25Q32BV@SOIC8", read: Uint8Array.of(1, 2, 3, 4), after: "verify" },
    log: [
      { id: 1, kind: "command", text: `minipro -p W25Q32BV@SOIC8 -w ${SECRET_PATH}` },
      { id: 2, kind: "output", text: "Writing Code..." },
    ],
    nextLogId: 3,
  };
}

describe("streamStatus", () => {
  it("sends the programmer, the chip, the operation, its percent and the outcome", () => {
    expect(streamStatus(busyState())).toEqual({
      programmer: "T48",
      chip: "W25Q32BV@SOIC8",
      running: { operation: "write", percent: 40 },
      outcome: { operation: "verify", tone: "error" },
    });
    expect(JSON.parse(JSON.stringify(streamStatus(busyState())))).toEqual(JSON.parse(fixture));
  });

  it("sends nothing that isn't on the list", () => {
    const status = streamStatus(busyState());
    // Field for field: a new one has to be added here on purpose.
    expect(Object.keys(status).sort()).toEqual(["chip", "outcome", "programmer", "running"]);
    expect(Object.keys(status.running ?? {}).sort()).toEqual(["operation", "percent"]);
    expect(Object.keys(status.outcome ?? {}).sort()).toEqual(["operation", "tone"]);

    const sent = JSON.stringify(status);
    for (const secret of [
      SECRET_PATH,
      "jane-doe",
      "/home",
      "minipro",
      "algorithm.xml",
      "Writing Code",
      "differs",
      "01.1.32",
      "not yet complete",
      "w25q",
      "AT28C256",
      "222", // 0xde, a byte of the buffer
    ]) {
      expect(sent).not.toContain(secret);
    }
  });

  it("says nothing of a programmer that isn't there, or a chip that isn't picked", () => {
    expect(streamStatus(initialState())).toEqual({
      programmer: null,
      chip: null,
      running: null,
      outcome: null,
    });
    // The model picked by hand to browse a chip list isn't a programmer on the bench.
    const browsing = initialState();
    browsing.programmer.manual = "t76";
    expect(streamStatus(browsing).programmer).toBeNull();
  });

  it("calls the read-back after a failed verify a read", () => {
    const state = busyState();
    state.running = { ...state.running!, phase: "readback", percent: null };
    expect(streamStatus(state).running).toEqual({ operation: "read", percent: null });
  });

  it("keeps the percent a whole number from 0 to 100", () => {
    const state = busyState();
    state.running = { ...state.running!, percent: 40.6 };
    expect(streamStatus(state).running?.percent).toBe(41);
    state.running = { ...state.running!, percent: 250 };
    expect(streamStatus(state).running?.percent).toBe(100);
    state.running = { ...state.running!, percent: -3 };
    expect(streamStatus(state).running?.percent).toBe(0);
  });
});
