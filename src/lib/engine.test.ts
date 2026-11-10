import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => {
  class Channel<T> {
    onmessage: (message: T) => void = () => {};
  }
  return { invoke, Channel };
});

import {
  deviceMayBeInconsistent,
  engine,
  errorMessage,
  isEngineError,
  mutatesDevice,
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

  it("knows which operations change the chip", () => {
    expect(mutatesDevice("write")).toBe(true);
    expect(mutatesDevice("erase")).toBe(true);
    expect(mutatesDevice("read")).toBe(false);
    expect(mutatesDevice("blank_check")).toBe(false);
  });
});
