import { describe, expect, it, vi } from "vitest";
import { createFakeBench, FAKE_PROBE, FAKE_TARGET, type FakeBenchOptions } from "../../dev/fakeBench";
import { EcController, flashromPathStore, type EcDeps } from "./controller";
import { WIRING } from "./state";

function setup(options: FakeBenchOptions = {}, deps: Partial<EcDeps> = {}) {
  const bench = createFakeBench(options);
  const controller = new EcController({ bench, ...deps });
  return { bench, controller };
}

function tickAll(controller: EcController) {
  for (const check of WIRING) controller.setWiring(check.id, true);
}

/** A controller that has found flashrom and the CH341A, with the wiring ticked. */
async function wired(options: FakeBenchOptions = {}, deps: Partial<EcDeps> = {}) {
  const made = setup(options, deps);
  await made.controller.open();
  tickAll(made.controller);
  return made;
}

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    items,
  };
}

describe("opening the screen", () => {
  it("finds flashrom, then looks for the CH341A, once", async () => {
    const { bench, controller } = setup();
    await Promise.all([controller.open(), controller.open()]);
    const state = controller.getState();
    expect(state.flashrom?.availability).toEqual({ status: "ready", version: "v1.8.0" });
    expect(state.probe).toMatchObject({ status: "found", info: { model: "CH341A" } });
    expect(bench.calls).toEqual(["list_probes"]);
    // Nothing has touched the chip.
    expect(state.session).toBeNull();
  });

  it("doesn't look for a programmer without a flashrom to look with", async () => {
    const { bench, controller } = setup({ flashrom: null });
    await controller.open();
    expect(controller.getState().flashrom?.availability.status).toBe("missing");
    expect(controller.getState().probe).toEqual({ status: "unknown" });
    expect(bench.calls).toEqual([]);
  });

  it("says so when no CH341A is plugged in, and asks the OS why", async () => {
    const { bench, controller } = setup({ programmer: false });
    await controller.open();
    expect(controller.getState().probe).toEqual({ status: "none" });
    expect(controller.getState().outcome).toBeNull();
    expect(bench.calls).toEqual(["list_probes", "diagnose_spi_programmer"]);
    expect(controller.getState().diagnosis).toEqual({
      os: "macos",
      programmers: [],
      probe_error: null,
    });
  });

  it("doesn't ask the OS anything when the CH341A is found", async () => {
    const { bench, controller } = setup();
    await controller.open();
    expect(bench.calls).toEqual(["list_probes"]);
    expect(controller.getState().diagnosis).toBeNull();
  });

  it("learns that a CH341A is plugged in but not its to open", async () => {
    const { bench, controller } = setup({ access: "no_udev_rule" });
    await controller.open();
    // flashrom's answer is the same as for no programmer at all...
    expect(controller.getState().probe).toEqual({ status: "none" });
    // ...and the OS's isn't.
    const [report] = controller.getState().diagnosis!.programmers;
    expect(report.usb_id).toBe("1a86:5512");
    expect(report.state.kind).toBe("udev_rules_missing");

    // The rule goes in; the next look finds it and the explanation goes.
    bench.setAccess("ok");
    await controller.lookForProgrammer();
    expect(controller.getState().probe.status).toBe("found");
    expect(controller.getState().diagnosis).toBeNull();
  });

  it("carries on when the diagnosis itself can't be had", async () => {
    const { bench, controller } = setup({ programmer: false });
    bench.diagnoseProgrammer = async () => {
      throw new Error("ipc down");
    };
    await controller.open();
    expect(controller.getState().probe).toEqual({ status: "none" });
    expect(controller.getState().diagnosis).toBeNull();
    expect(controller.getState().running).toBeNull();
  });
});

describe("the flashrom path", () => {
  it("is handed back from the last run", async () => {
    const storage = memoryStorage({ "burnwright.flashromPath": "/opt/flashrom" });
    const { controller } = setup(
      { flashrom: null, otherFlashroms: ["/opt/flashrom"] },
      { flashromPath: flashromPathStore(storage) },
    );
    await controller.open();
    const state = controller.getState();
    expect(state.flashrom).toMatchObject({ path: "/opt/flashrom", source: "configured" });
    expect(state.flashromChosen).toBe("/opt/flashrom");
    expect(state.probe.status).toBe("found");
  });

  it("is chosen from a file panel, remembered, and can be forgotten", async () => {
    const storage = memoryStorage();
    const chooseFlashrom = vi.fn<() => Promise<string | null>>().mockResolvedValue("/opt/flashrom");
    const { controller } = setup(
      { flashrom: null, otherFlashroms: ["/opt/flashrom"] },
      { chooseFlashrom, flashromPath: flashromPathStore(storage) },
    );
    await controller.open();
    expect(controller.canChooseFlashrom).toBe(true);
    await controller.chooseFlashrom();
    expect(controller.getState().flashrom?.path).toBe("/opt/flashrom");
    expect(storage.items.get("burnwright.flashromPath")).toBe("/opt/flashrom");
    // With a flashrom to run, the look for the programmer follows.
    expect(controller.getState().probe.status).toBe("found");

    await controller.clearFlashromPath();
    expect(controller.getState().flashrom?.availability.status).toBe("missing");
    expect(controller.getState().flashromChosen).toBeNull();
    expect(storage.items.has("burnwright.flashromPath")).toBe(false);
  });

  it("stays as it was when the file panel is closed", async () => {
    const chooseFlashrom = vi.fn<() => Promise<string | null>>().mockResolvedValue(null);
    const { controller } = setup({}, { chooseFlashrom });
    await controller.open();
    const before = controller.getState().flashrom;
    await controller.chooseFlashrom();
    expect(controller.getState().flashrom).toBe(before);
    expect(controller.getState().flashromBusy).toBe(false);
  });

  it("is found on a second look, after it's installed", async () => {
    const { bench, controller } = setup({ flashrom: null });
    await controller.open();
    bench.setInstalled("/usr/sbin/flashrom");
    await controller.checkFlashrom();
    expect(controller.getState().flashrom?.path).toBe("/usr/sbin/flashrom");
    expect(controller.getState().probe.status).toBe("found");
  });

  it("survives a storage that throws", () => {
    const store = flashromPathStore({
      getItem: () => {
        throw new Error("no");
      },
      setItem: () => {
        throw new Error("no");
      },
      removeItem: () => {
        throw new Error("no");
      },
    });
    expect(store.load()).toBeNull();
    expect(() => store.save("/x")).not.toThrow();
    expect(() => store.save(null)).not.toThrow();
  });
});

describe("identify and back up", () => {
  it("doesn't talk to the chip until every wiring check is ticked", async () => {
    const { bench, controller } = setup();
    await controller.open();
    await controller.identify();
    for (const check of WIRING.slice(1)) controller.setWiring(check.id, true);
    await controller.identify();
    expect(bench.calls).toEqual(["list_probes"]);
    controller.setWiring(WIRING[0].id, true);
    await controller.identify();
    expect(bench.calls).toEqual(["list_probes", "open_session"]);
  });

  it("opens a session on the KB9012 over the CH341A", async () => {
    const { bench, controller } = await wired();
    const openSession = vi.spyOn(bench, "openSession");
    await controller.identify();
    expect(openSession).toHaveBeenCalledWith(FAKE_PROBE, FAKE_TARGET, expect.anything());
    const state = controller.getState();
    expect(state.session?.chip.fingerprint).toBe("hwversion 0xc3, ediid 0x04");
    expect(state.outcome).toMatchObject({ tone: "ok", step: "identify" });
    expect(state.log.map((l) => l.kind)).toContain("command");
  });

  it("backs the chip up and keeps where it went", async () => {
    const { bench, controller } = await wired();
    await controller.backup();
    expect(bench.calls).not.toContain("backup_session");
    await controller.identify();
    const seen: (number | null)[] = [];
    controller.subscribe(() => {
      const percent = controller.getState().running?.percent ?? null;
      if (seen[seen.length - 1] !== percent) seen.push(percent);
    });
    await controller.backup();
    const state = controller.getState();
    expect(state.backup).toMatchObject({ len: 131072, region: "code" });
    expect(state.backup?.path).toMatch(/backups\/ene-KB9012/);
    expect(state.outcome).toMatchObject({ tone: "ok", title: "Backup saved" });
    expect(state.running).toBeNull();
    // Two reads, each counting up to 100.
    expect(seen.filter((p) => p === 100)).toHaveLength(2);
  });

  it("reports a chip that doesn't answer, and tries again when asked", async () => {
    const { controller } = await wired({ silentTries: 1 });
    await controller.identify();
    expect(controller.getState().outcome).toMatchObject({
      tone: "error",
      title: "Nothing answered",
    });
    expect(controller.getState().session).toBeNull();
    await controller.identify();
    expect(controller.getState().session).not.toBeNull();
  });

  it("saves nothing when the two reads differ", async () => {
    const { controller } = await wired({ chip: "flaky" });
    await controller.identify();
    await controller.backup();
    const state = controller.getState();
    expect(state.backup).toBeNull();
    expect(state.outcome?.title).toBe("The two reads don't match");
    // The session is still good for another go.
    expect(state.session).not.toBeNull();
  });

  it("notices the programmer going away", async () => {
    const { bench, controller } = await wired();
    bench.setProgrammer(false);
    await controller.identify();
    expect(controller.getState().outcome?.title).toBe("No CH341A found");
    expect(controller.getState().probe).toEqual({ status: "none" });
    // An identify that finds no programmer gets the OS's view as well.
    expect(bench.calls.slice(-2)).toEqual(["open_session", "diagnose_spi_programmer"]);
    expect(controller.getState().diagnosis?.programmers).toEqual([]);
  });

  it("closes the session when a wiring check is unticked", async () => {
    const { bench, controller } = await wired();
    await controller.identify();
    const id = controller.getState().session!.id;
    const closeSession = vi.spyOn(bench, "closeSession");
    controller.setWiring("signals", false);
    expect(closeSession).toHaveBeenCalledWith(id);
    expect(controller.getState().session).toBeNull();
    controller.setWiring("signals", true);
    await controller.backup();
    expect(bench.calls.filter((c) => c === "backup_session")).toHaveLength(0);
  });
});

describe("cancel", () => {
  it("stops a backup and says nothing was saved", async () => {
    const { controller } = await wired({ stepMs: 1, steps: 50 });
    await controller.identify();
    const done = controller.backup();
    await vi.waitFor(() => expect(controller.getState().running?.percent).not.toBeNull());
    controller.cancel();
    expect(controller.getState().running?.cancelling).toBe(true);
    // A second press changes nothing.
    controller.cancel();
    await done;
    const state = controller.getState();
    expect(state.running).toBeNull();
    expect(state.backup).toBeNull();
    expect(state.outcome).toMatchObject({ tone: "warning", title: "Backup cancelled" });
    expect(state.log.map((l) => l.text)).toContain("Cancelled: letting the EC run again");
  });

  it("holds the wiring checks while a step runs", async () => {
    const { controller } = await wired({ stepMs: 1, steps: 20 });
    await controller.identify();
    const done = controller.backup();
    controller.setWiring("ground", false);
    expect(controller.getState().wiring.ground).toBe(true);
    await done;
    expect(controller.getState().backup).not.toBeNull();
  });
});

describe("the saved file", () => {
  it("is shown in the file manager", async () => {
    const reveal = vi.fn<(path: string) => Promise<void>>().mockResolvedValue();
    const { controller } = await wired({}, { reveal });
    expect(controller.canReveal).toBe(true);
    await controller.revealBackup();
    expect(reveal).not.toHaveBeenCalled();
    await controller.identify();
    await controller.backup();
    await controller.revealBackup();
    expect(reveal).toHaveBeenCalledWith(controller.getState().backup!.path);
  });

  it("logs it when the file manager won't open", async () => {
    const reveal = vi.fn<(path: string) => Promise<void>>().mockRejectedValue("denied");
    const { controller } = await wired({}, { reveal });
    await controller.identify();
    await controller.backup();
    await controller.revealBackup();
    const log = controller.getState().log;
    const last = log[log.length - 1];
    expect(last).toMatchObject({ kind: "error" });
    expect(last?.text).toMatch(/Couldn't show .*denied/);
  });
});
