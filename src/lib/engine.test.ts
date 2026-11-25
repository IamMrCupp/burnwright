import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => {
  class Channel<T> {
    onmessage: (message: T) => void = () => {};
  }
  return { invoke, Channel };
});

import {
  algorithmFileMissing,
  bench,
  CH341A,
  chipAvailableOn,
  deviceMayBeInconsistent,
  engine,
  errorMessage,
  isEngineError,
  isNoProgrammer,
  KB9012,
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

describe("inspectBuffer", () => {
  const report = {
    len: 4,
    findings: [
      { offset: 0, size: 4, kind: "gzip", description: "gzip compressed data", confidence: "high" },
    ],
    entropy: { block: 256, millibits: [2000] },
  };

  function lastScan(): { body: unknown; opId: string } {
    const call = invoke.mock.calls.filter(([c]) => c === "inspect_buffer").pop();
    if (!call) throw new Error("inspect_buffer was not invoked");
    const { headers } = call[2] as { headers: Record<string, string> };
    return { body: call[1], opId: headers["burnwright-op-id"] };
  }

  it("sends the bytes as the body, untouched, with the operation id in a header", async () => {
    invoke.mockResolvedValue(report);
    const bytes = Uint8Array.of(0x1f, 0x8b, 0x08, 0x00);
    await expect(engine.inspectBuffer(bytes)).resolves.toEqual(report);
    const { body, opId } = lastScan();
    // The same Uint8Array: Tauri posts it as raw bytes, where an array of
    // numbers would be four characters a byte.
    expect(body).toBe(bytes);
    expect(opId).toMatch(/\S/);
  });

  it("gives every scan its own id", async () => {
    invoke.mockResolvedValue(report);
    await engine.inspectBuffer(new Uint8Array(1));
    const first = lastScan().opId;
    await engine.inspectBuffer(new Uint8Array(1));
    expect(lastScan().opId).not.toBe(first);
  });

  it("cancels by that id when the signal is aborted", async () => {
    let finish: (value: unknown) => void = () => {};
    invoke.mockImplementation((command: string) =>
      command === "inspect_buffer"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(true),
    );
    const abort = new AbortController();
    const scan = engine.inspectBuffer(new Uint8Array(8), { signal: abort.signal });
    abort.abort();
    expect(invoke).toHaveBeenLastCalledWith("cancel_operation", { opId: lastScan().opId });
    finish(report);
    await scan;
  });

  it("cancels a scan whose signal was aborted before it started", async () => {
    invoke.mockResolvedValue(true);
    const abort = new AbortController();
    abort.abort();
    await engine.inspectBuffer(new Uint8Array(8), { signal: abort.signal });
    const cancels = invoke.mock.calls.filter(([c]) => c === "cancel_operation");
    expect(cancels).toEqual([["cancel_operation", { opId: lastScan().opId }]]);
  });

  it("passes the engine's rejection through", async () => {
    const failed = { kind: "scan_failed", message: "the scan stopped", device_state: null };
    invoke.mockRejectedValue(failed);
    await expect(engine.inspectBuffer(new Uint8Array(1))).rejects.toBe(failed);
    expect(isEngineError(failed)).toBe(true);
  });
});

describe("algorithm file", () => {
  it("asks for the state and sets the path by the commands' names", async () => {
    const status = { configured: null, found: null, default_path: "/s/algorithm.xml" };
    invoke.mockResolvedValue(status);
    await expect(engine.algorithmFile()).resolves.toEqual(status);
    expect(invoke).toHaveBeenLastCalledWith("algorithm_file");
    await engine.setAlgorithmPath("/home/me/algorithm.xml");
    expect(invoke).toHaveBeenLastCalledWith("set_algorithm_path", {
      path: "/home/me/algorithm.xml",
    });
    await engine.setAlgorithmPath(null);
    expect(invoke).toHaveBeenLastCalledWith("set_algorithm_path", { path: null });
  });

  it("is missing only when burnwright knows where minipro looks", () => {
    const base = { configured: null, found: null, default_path: null };
    expect(algorithmFileMissing({ ...base, default_path: "/s/algorithm.xml" })).toBe(true);
    expect(algorithmFileMissing({ ...base, configured: "/x.xml" })).toBe(true);
    expect(algorithmFileMissing(base)).toBe(false);
    expect(
      algorithmFileMissing({ ...base, found: "/s/algorithm.xml", default_path: "/s/algorithm.xml" }),
    ).toBe(false);
  });
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

  it("leaves minipro's checks on unless told otherwise", async () => {
    invoke.mockResolvedValue(undefined);
    await engine.write("A", "code", [1]);
    expect(lastArgs("write").overrides).toEqual({
      ignore_chip_id: false,
      ignore_size: false,
    });
    await engine.write("A", "code", [1], { ignoreSize: true });
    expect(lastArgs("write").overrides).toEqual({
      ignore_chip_id: false,
      ignore_size: true,
    });
    await engine.erase("A", { ignoreChipId: true });
    expect(lastArgs("erase").overrides).toEqual({
      ignore_chip_id: true,
      ignore_size: false,
    });
    for (const command of ["read", "verify", "blank_check"] as const) {
      invoke.mockResolvedValue(command === "read" ? [] : undefined);
      if (command === "read") await engine.read("A", "code", { ignoreChipId: true });
      if (command === "verify") await engine.verify("A", "code", [1], { ignoreChipId: true });
      if (command === "blank_check") await engine.blankCheck("A", { ignoreChipId: true });
      expect(lastArgs(command).overrides).toMatchObject({ ignore_chip_id: true });
    }
  });

  it("sends no overrides with detect or checkChip", async () => {
    invoke.mockResolvedValue({});
    await engine.detect();
    await engine.checkChip("A");
    expect(lastArgs("detect")).not.toHaveProperty("overrides");
    expect(lastArgs("check_chip")).not.toHaveProperty("overrides");
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

describe("session commands", () => {
  it("asks about flashrom and sets its path by the commands' names", async () => {
    const status = {
      availability: { status: "ready", version: "v1.8.0" },
      path: "/opt/homebrew/sbin/flashrom",
      source: "system",
    };
    invoke.mockResolvedValue(status);
    await expect(bench.flashromStatus()).resolves.toEqual(status);
    expect(invoke).toHaveBeenLastCalledWith("flashrom_status");
    await bench.setFlashromPath("/opt/flashrom");
    expect(invoke).toHaveBeenLastCalledWith("set_flashrom_path", {
      path: "/opt/flashrom",
    });
    await bench.setFlashromPath(null);
    expect(invoke).toHaveBeenLastCalledWith("set_flashrom_path", { path: null });
  });

  it("names the CH341A and the KB9012 the way the backend does", () => {
    expect(CH341A).toEqual({
      kind: "spi_master",
      master: { model: "ch341a" },
      clock_hz: null,
    });
    expect(KB9012).toEqual({ family: "ene_kb", part: "KB9012 (EDI)" });
  });

  it("lists probes as a device operation", async () => {
    invoke.mockResolvedValueOnce([]);
    await expect(bench.listProbes()).resolves.toEqual([]);
    const args = lastArgs("list_probes");
    expect(args.opId).toEqual(expect.any(String));
    expect(args.onProgress).toBeDefined();
  });

  it("asks why no CH341A was found, with no arguments", async () => {
    const diagnosis = { os: "linux", programmers: [], probe_error: null };
    invoke.mockResolvedValueOnce(diagnosis);
    await expect(bench.diagnoseProgrammer()).resolves.toEqual(diagnosis);
    expect(invoke).toHaveBeenLastCalledWith("diagnose_spi_programmer");
  });

  it("opens a session on a probe and a target", async () => {
    invoke.mockResolvedValueOnce({ id: 7 });
    await expect(bench.openSession(CH341A, KB9012)).resolves.toEqual({ id: 7 });
    expect(lastArgs("open_session")).toMatchObject({
      probe: CH341A,
      target: KB9012,
      opId: expect.any(String),
    });
  });

  it("backs up a session by id, with progress and cancel", async () => {
    const seen: ProgressEvent[] = [];
    const controller = new AbortController();
    invoke.mockImplementation(async (cmd: string, args: DeviceArgs) => {
      if (cmd !== "backup_session") return true;
      args.onProgress.onmessage({ type: "progress", stage: "read", percent: 12 });
      controller.abort();
      return { path: "/b/x.bin", sha256: "ab", len: 131072, region: "code" };
    });
    const saved = await bench.backup(7, {
      onProgress: (e) => seen.push(e),
      signal: controller.signal,
    });
    expect(saved.len).toBe(131072);
    const args = lastArgs("backup_session");
    expect(args).toMatchObject({ sessionId: 7, kind: null });
    expect(seen).toEqual([{ type: "progress", stage: "read", percent: 12 }]);
    // The abort reached the backend as a cancel of this operation.
    expect(invoke).toHaveBeenCalledWith("cancel_operation", { opId: args.opId });
  });

  it("closes a session by id", async () => {
    invoke.mockResolvedValueOnce(true);
    await expect(bench.closeSession(7)).resolves.toBe(true);
    expect(invoke).toHaveBeenLastCalledWith("close_session", { sessionId: 7 });
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
