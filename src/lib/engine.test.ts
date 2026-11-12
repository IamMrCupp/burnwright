import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => {
  class Channel<T> {
    onmessage: (message: T) => void = () => {};
  }
  return { invoke, Channel };
});

import {
  chipAvailableOn,
  deviceMayBeInconsistent,
  engine,
  errorMessage,
  isEngineError,
  isNoProgrammer,
  mutatesDevice,
  programmerFromModel,
  PROGRAMMERS,
  type ChipInfo,
  type ChipSearch,
  type ProgressEvent,
} from "./engine";

interface DeviceArgs {
  opId: string;
  onProgress: { onmessage: (e: ProgressEvent) => void };
  [key: string]: unknown;
}

function lastArgs(command: string): DeviceArgs {
  const calls = invoke.mock.calls.filter(([c]) => c === command);
  const call = calls[calls.length - 1];
  if (!call) throw new Error(`${command} was not invoked`);
  return call[1] as DeviceArgs;
}

beforeEach(() => {
  invoke.mockReset();
});

describe("device commands", () => {
  it("passes arguments, an op id and a progress channel", async () => {
    invoke.mockResolvedValueOnce([1, 2, 3]);
    await expect(engine.read("W25Q32BV@SOIC8", "code")).resolves.toEqual([
      1, 2, 3,
    ]);
    const args = lastArgs("read");
    expect(args).toMatchObject({ part: "W25Q32BV@SOIC8", kind: "code" });
    expect(args.opId).toEqual(expect.any(String));
    expect(args.onProgress).toBeDefined();
  });

  it("gives every operation its own id", async () => {
    invoke.mockResolvedValue(undefined);
    await engine.erase("A");
    await engine.erase("A");
    const ids = invoke.mock.calls.map(([, a]) => (a as DeviceArgs).opId);
    expect(new Set(ids).size).toBe(2);
  });

  it("sends write data as a plain array", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await engine.write("A", "data", new Uint8Array([0, 255, 7]));
    expect(lastArgs("write").data).toEqual([0, 255, 7]);
  });

  it("routes progress to onProgress", async () => {
    const seen: ProgressEvent[] = [];
    invoke.mockImplementationOnce(async (_cmd, args: DeviceArgs) => {
      args.onProgress.onmessage({ type: "progress", stage: "write", percent: 40 });
    });
    await engine.write("A", "code", [1], { onProgress: (e) => seen.push(e) });
    expect(seen).toEqual([{ type: "progress", stage: "write", percent: 40 }]);
  });

  it("maps camelCase arguments for checkChip", async () => {
    invoke.mockResolvedValueOnce({});
    await engine.checkChip("A", true);
    expect(lastArgs("check_chip")).toMatchObject({ part: "A", pinCheck: true });
  });

  it("cancels through the signal with the operation's id", async () => {
    const controller = new AbortController();
    let finish: (v: unknown) => void = () => {};
    invoke.mockImplementation((command: string) =>
      command === "cancel_operation"
        ? Promise.resolve(true)
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    const pending = engine.erase("A", { signal: controller.signal });
    controller.abort();
    finish(undefined);
    await pending;
    expect(lastArgs("cancel_operation").opId).toBe(lastArgs("erase").opId);
  });

  it("cancels straight away when the signal is already aborted", async () => {
    invoke.mockResolvedValue(true);
    await engine.blankCheck("A", { signal: AbortSignal.abort() });
    const commands = invoke.mock.calls.map(([c]) => c);
    expect(commands).toEqual(["cancel_operation", "blank_check"]);
  });

  it("stops listening to the signal once the operation settles", async () => {
    invoke.mockResolvedValue(undefined);
    const controller = new AbortController();
    await engine.erase("A", { signal: controller.signal });
    controller.abort();
    expect(invoke.mock.calls.map(([c]) => c)).toEqual(["erase"]);
  });
});

describe("chip commands", () => {
  // As `chip_info` serializes W25Q32BV@SOIC8 (see the engine's chips tests).
  const w25q32: ChipInfo = {
    name: "W25Q32BV@SOIC8",
    package: "SOIC8",
    kind: "programmable",
    available_on: ["tl866ii", "t48", "t56"],
    memory: { size: 4194304, unit: "bytes", bytes: 4194304, data_sizes: [] },
    socket: { kind: "dip", pins: 8 },
    icsp: "ICP009.JPG",
    protocol: 3,
    read_buffer_size: 4096,
    write_buffer_size: 256,
    details: [],
  };

  it("lists chips for a programmer, with no op id or progress channel", async () => {
    const list = {
      programmer: "t48",
      chips: [{ name: "W25Q32BV@SOIC8", package: "SOIC8", custom: false }],
    };
    invoke.mockResolvedValueOnce(list);
    await expect(engine.listChips("t48")).resolves.toEqual(list);
    expect(invoke).toHaveBeenCalledWith("list_chips", { programmer: "t48" });
  });

  it("searches with the query and a limit", async () => {
    const hits: ChipSearch = {
      total: 57,
      chips: [{ name: "W25Q32BV", package: null, custom: false }],
    };
    invoke.mockResolvedValue(hits);
    await expect(engine.searchChips("t56", "w25q32 soic", 20)).resolves.toEqual(
      hits,
    );
    expect(invoke).toHaveBeenLastCalledWith("search_chips", {
      programmer: "t56",
      query: "w25q32 soic",
      limit: 20,
    });
    // No limit: the backend's default.
    await engine.searchChips("tl866a", "");
    expect(invoke).toHaveBeenLastCalledWith("search_chips", {
      programmer: "tl866a",
      query: "",
      limit: null,
    });
  });

  it("describes a chip", async () => {
    invoke.mockResolvedValueOnce(w25q32);
    await expect(engine.chipInfo("t48", "w25q32bv@soic8")).resolves.toEqual(
      w25q32,
    );
    expect(invoke).toHaveBeenCalledWith("chip_info", {
      programmer: "t48",
      name: "w25q32bv@soic8",
    });
  });

  it("passes the typed chip errors through", async () => {
    for (const kind of [
      "unknown_chip",
      "missing_database",
      "unsupported_programmer",
    ]) {
      const error = { kind, message: "x", device_state: null };
      invoke.mockRejectedValueOnce(error);
      const rejection = await engine.chipInfo("t76", "NOPE").catch((e) => e);
      expect(isEngineError(rejection)).toBe(true);
      expect(rejection).toEqual(error);
    }
  });

  it("maps the model names detect reports to programmers", () => {
    expect(programmerFromModel("TL866A")).toBe("tl866a");
    expect(programmerFromModel("TL866CS")).toBe("tl866a");
    expect(programmerFromModel("TL866II+")).toBe("tl866ii");
    expect(programmerFromModel("T48")).toBe("t48");
    expect(programmerFromModel("T56")).toBe("t56");
    expect(programmerFromModel(" t76 ")).toBe("t76");
    expect(programmerFromModel("T100")).toBeNull();
    expect(programmerFromModel("")).toBeNull();
    // Every picker entry maps back to itself by id and by label.
    for (const { id, label } of PROGRAMMERS) {
      expect(programmerFromModel(id)).toBe(id);
      expect(programmerFromModel(label)).toBe(id);
    }
    expect(PROGRAMMERS.map((p) => p.id)).toEqual([
      "tl866a",
      "tl866ii",
      "t48",
      "t56",
      "t76",
    ]);
  });

  it("says whether a programmer takes a chip", () => {
    expect(chipAvailableOn(w25q32, "t48")).toBe(true);
    expect(chipAvailableOn(w25q32, "tl866a")).toBe(false);
    const t56Only: ChipInfo = { ...w25q32, available_on: ["t56"] };
    expect(chipAvailableOn(t56Only, "t48")).toBe(false);
    // A logic IC: minipro prints no availability.
    const logic: ChipInfo = {
      ...w25q32,
      kind: "logic",
      available_on: [],
      memory: null,
    };
    expect(chipAvailableOn(logic, "t48")).toBeNull();
  });
});

describe("diagnoseProgrammer", () => {
  it("invokes diagnose_programmer with no arguments", async () => {
    const diagnosis = { os: "linux", programmers: [], probe_error: null };
    invoke.mockResolvedValueOnce(diagnosis);
    await expect(engine.diagnoseProgrammer()).resolves.toEqual(diagnosis);
    expect(invoke).toHaveBeenCalledWith("diagnose_programmer");
  });
});

describe("errors", () => {
  const cancelledWrite = {
    kind: "cancelled",
    message: "write cancelled: the device may be in an inconsistent state",
    device_state: "may_be_inconsistent",
  };

  it("recognises engine errors", () => {
    expect(isEngineError(cancelledWrite)).toBe(true);
    expect(isEngineError("boom")).toBe(false);
    expect(isEngineError(null)).toBe(false);
  });

  it("flags a cancelled write as possibly inconsistent", () => {
    expect(deviceMayBeInconsistent(cancelledWrite)).toBe(true);
    expect(
      deviceMayBeInconsistent({
        kind: "cancelled",
        message: "read cancelled",
        device_state: "unchanged",
      }),
    ).toBe(false);
    expect(deviceMayBeInconsistent(new Error("x"))).toBe(false);
  });

  it("formats any rejection", () => {
    expect(errorMessage(cancelledWrite)).toBe(cancelledWrite.message);
    expect(errorMessage(new Error("bad"))).toBe("bad");
    expect(errorMessage("plain")).toBe("plain");
  });

  it("spots a missing programmer", () => {
    const none = { kind: "no_programmer", message: "x", device_state: null };
    expect(isNoProgrammer(none)).toBe(true);
    expect(isNoProgrammer(cancelledWrite)).toBe(false);
    expect(isNoProgrammer("no_programmer")).toBe(false);
  });

  it("knows which operations change the chip", () => {
    expect(mutatesDevice("write")).toBe(true);
    expect(mutatesDevice("erase")).toBe(true);
    expect(mutatesDevice("read")).toBe(false);
    expect(mutatesDevice("blank_check")).toBe(false);
  });
});
