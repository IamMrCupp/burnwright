import { describe, expect, it, vi } from "vitest";
import { createFakeEngine, fakeChip } from "../../dev/fakeEngine";
import { DeviceController } from "../device/controller";
import { selectedLookup } from "../device/state";
import { StreamController, type StreamBackend, type StreamServerState } from "./controller";
import { streamSettingsStore, type StreamSettings } from "./settings";
import type { StreamStatus } from "./status";

const SECRET_PATH = "/home/me/customers/jane-doe/bios-dump.bin";

const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];
const soon = (assertion: () => void) => vi.waitFor(assertion, { interval: 2 });

function memoryStorage(settings?: StreamSettings) {
  const stored = new Map<string, string>();
  if (settings) stored.set("burnwright.stream", JSON.stringify(settings));
  return {
    stored,
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  };
}

/** A server that does what it's told, unless `taken` holds the port. */
function fakeBackend(taken: number[] = []) {
  const configured: [boolean, number][] = [];
  /** Every status sent, as the JSON that crosses to the Rust side. */
  const published: string[] = [];
  let running = false;
  const backend: StreamBackend = {
    async configure(enabled, port): Promise<StreamServerState> {
      configured.push([enabled, port]);
      running = enabled && !taken.includes(port);
      if (!enabled) return { running: false, url: null, error: null };
      if (!running) {
        return { running: false, url: null, error: `Port ${port} is in use by something else.` };
      }
      return { running: true, url: `http://127.0.0.1:${port}/stream`, error: null };
    },
    async publish(status) {
      published.push(JSON.stringify(status));
    },
  };
  const statuses = () => published.map((json) => JSON.parse(json) as StreamStatus);
  return { backend, configured, published, statuses, isRunning: () => running };
}

function setup(settings?: StreamSettings, taken: number[] = []) {
  const image = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + i);
  const engine = createFakeEngine({
    chips: [{ info: fakeChip("FLASH32@SOIC8", 32), id: "0xEF4016" }],
    socket: { chip: "FLASH32@SOIC8", memory: new Uint8Array(32).fill(0xff) },
    files: { [SECRET_PATH]: image },
    steps: 5,
  });
  const device = new DeviceController({
    engine,
    dialogs: {
      open: async () => SECRET_PATH,
      save: async () => null,
      openAlgorithms: async () => null,
    },
  });
  const storage = memoryStorage(settings);
  const fake = fakeBackend(taken);
  const stream = new StreamController({
    backend: fake.backend,
    device,
    settings: streamSettingsStore(storage),
  });
  const ready = async () => {
    await device.detect();
    device.selectChip({ name: "FLASH32@SOIC8", package: null });
    await soon(() => expect(selectedLookup(device.getState())?.status).toBe("ready"));
  };
  const idle = () => soon(() => expect(device.getState().running).toBeNull());
  return { device, stream, storage, ready, idle, ...fake };
}

const ON: StreamSettings = { enabled: true, port: 8790, hidePaths: false };

describe("the setting", () => {
  it("is off by default: the server is never asked for, and nothing is sent", async () => {
    const { stream, device, ready, idle, configured, published } = setup();
    expect(stream.getState()).toEqual({
      settings: { enabled: false, port: 8790, hidePaths: false },
      server: { running: false, url: null, error: null },
    });
    await ready();
    void device.run("read");
    await idle();
    expect(configured).toEqual([]);
    expect(published).toEqual([]);
  });

  it("starts the server when it was left on", async () => {
    const { stream, configured } = setup(ON);
    expect(stream.getState().server).toBeNull();
    await soon(() => expect(stream.getState().server?.running).toBe(true));
    expect(configured).toEqual([[true, 8790]]);
    expect(stream.getState().server?.url).toBe("http://127.0.0.1:8790/stream");
  });

  it("turns the server on and off, and remembers it", async () => {
    const { stream, storage, configured, isRunning } = setup();
    await stream.setEnabled(true);
    expect(isRunning()).toBe(true);
    expect(stream.getState().server?.running).toBe(true);
    expect(JSON.parse(storage.stored.get("burnwright.stream")!)).toEqual(ON);

    await stream.setEnabled(false);
    expect(isRunning()).toBe(false);
    expect(stream.getState().server).toEqual({ running: false, url: null, error: null });
    expect(JSON.parse(storage.stored.get("burnwright.stream")!)).toEqual({
      enabled: false,
      port: 8790,
      hidePaths: false,
    });
    expect(configured).toEqual([
      [true, 8790],
      [false, 8790],
    ]);
  });

  it("moves to another port", async () => {
    const { stream, configured } = setup(ON);
    await soon(() => expect(stream.getState().server?.running).toBe(true));
    await stream.setPort(9001);
    expect(stream.getState().server?.url).toBe("http://127.0.0.1:9001/stream");
    expect(configured).toEqual([
      [true, 8790],
      [true, 9001],
    ]);
  });

  it("ignores a port the page can't be served on", async () => {
    const { stream, configured, storage } = setup();
    for (const port of [80, 70000, 8790.5, NaN]) await stream.setPort(port);
    expect(stream.getState().settings.port).toBe(8790);
    expect(configured).toEqual([]);
    expect(storage.stored.size).toBe(0);
  });

  it("says why when the port is taken, and recovers on another", async () => {
    const { stream } = setup(ON, [8790]);
    await soon(() => expect(stream.getState().server).not.toBeNull());
    expect(stream.getState().server).toEqual({
      running: false,
      url: null,
      error: "Port 8790 is in use by something else.",
    });
    await stream.setPort(8791);
    expect(stream.getState().server?.running).toBe(true);
  });

  it("reports a backend that throws", async () => {
    const device = new DeviceController({
      engine: createFakeEngine(),
      dialogs: { open: async () => null, save: async () => null, openAlgorithms: async () => null },
    });
    const stream = new StreamController({
      backend: {
        configure: async () => {
          throw new Error("no such command");
        },
        publish: async () => {},
      },
      device,
    });
    await stream.setEnabled(true);
    expect(stream.getState().server).toEqual({
      running: false,
      url: null,
      error: "no such command",
    });
  });

  it("hides paths without touching the server, and remembers it", () => {
    const { stream, storage, configured } = setup();
    const listener = vi.fn();
    stream.subscribe(listener);
    stream.setHidePaths(true);
    expect(stream.getState().settings.hidePaths).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.stored.get("burnwright.stream")!)).toEqual({
      enabled: false,
      port: 8790,
      hidePaths: true,
    });
    stream.setHidePaths(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(configured).toEqual([]);
  });

  it("tells its listeners", async () => {
    const { stream } = setup();
    const listener = vi.fn();
    const stop = stream.subscribe(listener);
    await stream.setEnabled(true);
    expect(listener).toHaveBeenCalled();
    stop();
    listener.mockClear();
    await stream.setEnabled(false);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("what the page is sent", () => {
  it("follows an operation from the chip to the outcome", async () => {
    const { stream, device, ready, idle, statuses } = setup(ON);
    await soon(() => expect(stream.getState().server?.running).toBe(true));
    await ready();
    await soon(() =>
      expect(last(statuses())).toEqual({
        programmer: "T48",
        chip: "FLASH32@SOIC8",
        running: null,
        outcome: null,
      }),
    );

    void device.run("read");
    await idle();
    await soon(() => expect(last(statuses())?.outcome).toEqual({ operation: "read", tone: "ok" }));

    const during = statuses().filter((status) => status.running !== null);
    expect(during.length).toBeGreaterThan(0);
    expect(during.every((status) => status.running?.operation === "read")).toBe(true);
    expect(during.every((status) => status.chip === "FLASH32@SOIC8")).toBe(true);
    const percents = during.map((status) => status.running?.percent ?? -1);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(last(percents)).toBe(100);
  });

  it("keeps file paths, the log and the buffer off the page through a whole session", async () => {
    const { stream, device, ready, idle, published } = setup(ON);
    await soon(() => expect(stream.getState().server?.running).toBe(true));
    await ready();

    // Open a file, write it, verify it, then change a byte and verify
    // again so there's a failure with a diff: everything the screen does
    // with a path or the buffer's bytes.
    await device.openFile();
    expect(device.getState().buffer?.path).toBe(SECRET_PATH);
    void device.run("write");
    await soon(() => expect(device.getState().confirm?.kind).toBe("write"));
    device.confirm();
    await soon(() => expect(device.getState().outcome?.op).toBe("write"));
    void device.run("verify");
    await soon(() => expect(device.getState().outcome?.op).toBe("verify"));
    const edited = device.getState().buffer!.bytes.slice();
    edited[3] ^= 0xff;
    device.editBuffer(edited, true);
    void device.run("verify");
    await soon(() => expect(device.getState().outcome?.tone).toBe("error"));
    await idle();

    // The screen itself holds all of it...
    const log = device.getState().log.map((line) => line.text).join("\n");
    expect(log).toContain(SECRET_PATH);
    expect(device.getState().diff).not.toBeNull();

    // ...and none of it was sent.
    expect(published.length).toBeGreaterThan(5);
    for (const json of published) {
      expect(json).not.toContain("jane-doe");
      expect(json).not.toContain("/home");
      expect(json).not.toContain(".bin");
      expect(json).not.toContain("minipro");
      const status = JSON.parse(json) as Record<string, Record<string, unknown> | null>;
      expect(Object.keys(status).sort()).toEqual(["chip", "outcome", "programmer", "running"]);
      if (status.running) {
        expect(Object.keys(status.running).sort()).toEqual(["operation", "percent"]);
      }
      if (status.outcome) {
        expect(Object.keys(status.outcome).sort()).toEqual(["operation", "tone"]);
      }
      // Two names, two enums and a number: nowhere for a byte to ride.
      for (const value of [status.programmer, status.chip]) {
        expect(value === null || typeof value === "string").toBe(true);
      }
    }
    const tones = published.map((json) => (JSON.parse(json) as StreamStatus).outcome?.tone);
    expect(tones).toContain("ok");
    expect(tones).toContain("error");
  });

  it("sends each status once", async () => {
    const { stream, device, ready, published } = setup(ON);
    await soon(() => expect(stream.getState().server?.running).toBe(true));
    await ready();
    await soon(() => expect(last(published)).toContain("FLASH32@SOIC8"));
    const before = published.length;
    // Typing in the picker changes the screen's state, not the page's.
    device.setQuery("fla");
    device.setQuery("flas");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(published.length).toBe(before);
    for (let i = 1; i < published.length; i++) {
      expect(published[i]).not.toBe(published[i - 1]);
    }
  });

  it("sends the current status again when the server comes back on", async () => {
    const { stream, ready, published } = setup(ON);
    await soon(() => expect(stream.getState().server?.running).toBe(true));
    await ready();
    await soon(() => expect(last(published)).toContain("FLASH32@SOIC8"));
    await stream.setEnabled(false);
    const before = published.length;
    await stream.setEnabled(true);
    await soon(() => expect(published.length).toBe(before + 1));
    expect(last(published)).toBe(published[before - 1]);
  });

  it("sends statuses one at a time, and ends on the latest", async () => {
    const device = new DeviceController({
      engine: createFakeEngine({ chips: [{ info: fakeChip("FLASH32@SOIC8", 32) }] }),
      dialogs: { open: async () => null, save: async () => null, openAlgorithms: async () => null },
    });
    let inFlight = 0;
    let most = 0;
    const published: StreamStatus[] = [];
    const stream = new StreamController({
      backend: {
        configure: async () => ({ running: true, url: "http://127.0.0.1:8790/stream", error: null }),
        publish: async (status) => {
          most = Math.max(most, ++inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          published.push(status);
          inFlight--;
        },
      },
      device,
    });
    await stream.setEnabled(true);
    await device.detect();
    device.selectChip({ name: "FLASH32@SOIC8", package: null });
    device.clearChip();
    device.selectChip({ name: "FLASH32@SOIC8", package: null });
    await soon(() => expect(last(published)?.chip).toBe("FLASH32@SOIC8"));
    await soon(() => expect(inFlight).toBe(0));
    expect(most).toBe(1);
    expect(last(published)).toEqual({
      programmer: "T48",
      chip: "FLASH32@SOIC8",
      running: null,
      outcome: null,
    });
  });
});
