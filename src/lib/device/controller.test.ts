import { describe, expect, it, vi } from "vitest";
import {
  createFakeEngine,
  fakeChip,
  type FakeChip,
  type FakeEngineOptions,
  type FakeSocket,
} from "../../dev/fakeEngine";
import type { DeviceInfo, Diagnosis } from "../engine";
import { DeviceController } from "./controller";
import { confirmCopy } from "./messages";
import { recentStore } from "./recent";
import { settingsStore, type SettingsStore } from "./settings";
import {
  activeProgrammer,
  bufferSizeCheck,
  logText,
  lookupFor,
  operationAvailability,
  selectedInfo,
  selectedLookup,
  unsavedBuffer,
} from "./state";

// Small chips, so the tests move bytes, not megabytes.
const CHIPS: FakeChip[] = [
  { info: fakeChip("EEPROM16", 16) },
  { info: fakeChip("FLASH32@SOIC8", 32), id: "0xEF4016" },
  { info: fakeChip("OTHER32@SOIC8", 32), id: "0xC22016" },
  { info: fakeChip("T56ONLY", 16, { available_on: ["t56"] }) },
  {
    info: fakeChip("NAND@SOP16", 0, {
      memory: { size: 0, unit: "bytes", bytes: null, data_sizes: [64] },
    }),
  },
  {
    info: fakeChip("GAL16V8D", 0, {
      memory: { size: 2194, unit: "bits", bytes: null, data_sizes: [] },
    }),
  },
  { info: fakeChip("AT28C256E", 16), unreadable: true },
  {
    info: {
      ...fakeChip("7400", 0),
      kind: "logic",
      available_on: [],
      memory: null,
    },
  },
];

/** `vi.waitFor`, polling often: the fake answers within a few microtasks. */
const soon = (assertion: () => void) => vi.waitFor(assertion, { interval: 2 });
const bytes = (...values: number[]) => Uint8Array.from(values);
const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];
const ramp = (length: number, from = 0) =>
  Uint8Array.from({ length }, (_, i) => (from + i) & 0xff);

function socketWith(chip: string, memory: Uint8Array): FakeSocket {
  return { chip, memory };
}

function setup(options: FakeEngineOptions = {}, settings?: SettingsStore) {
  const fake = createFakeEngine({ chips: CHIPS, ...options });
  const dialogs = {
    open: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
    save: vi.fn<(suggested: string) => Promise<string | null>>().mockResolvedValue(null),
    openAlgorithms: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
  };
  const closeWindow = vi.fn<() => void>();
  const controller = new DeviceController({ engine: fake, dialogs, closeWindow, settings });
  const state = () => controller.getState();
  /** Wait for the running operation to end. */
  const idle = () => soon(() => expect(state().running).toBeNull());
  /** Detect, pick `chip` and wait for its details. */
  const ready = async (chip: string) => {
    await controller.detect();
    controller.selectChip({ name: chip, package: null });
    await soon(() => expect(selectedLookup(state())?.status).not.toBe("loading"));
  };
  const commands = () => fake.calls.map((call) => call.command);
  return { fake, dialogs, closeWindow, controller, state, idle, ready, commands };
}

describe("programmer", () => {
  it("finds the programmer and searches its chip list", async () => {
    const { controller, state } = setup();
    expect(state().programmer.status).toBe("unknown");
    await controller.detect();
    expect(state().programmer.status).toBe("found");
    expect(state().programmer.device?.programmer).toBe("T48");
    expect(activeProgrammer(state())).toBe("t48");
  });

  it("asks the OS why when there is no programmer", async () => {
    const diagnosis: Diagnosis = { os: "macos", programmers: [], probe_error: null };
    const { controller, state, commands } = setup({ programmer: null, diagnosis });
    await controller.detect();
    expect(state().programmer.status).toBe("none");
    expect(state().programmer.diagnosis).toEqual(diagnosis);
    expect(state().programmer.diagnosing).toBe(false);
    expect(commands()).toEqual(["detect", "diagnoseProgrammer"]);
  });

  it("still says there's no programmer when the diagnosis call fails", async () => {
    const { controller, state, fake } = setup({ programmer: null });
    fake.diagnoseProgrammer = () => Promise.reject(new Error("ipc down"));
    await controller.detect();
    expect(state().programmer.status).toBe("none");
    expect(state().programmer.diagnosis).toBeNull();
  });

  it("reports a detect that fails for another reason", async () => {
    const { controller, state, fake } = setup();
    fake.detect = () =>
      Promise.reject({
        kind: "minipro_not_found",
        message: "minipro isn't installed",
        device_state: null,
      });
    await controller.detect();
    expect(state().programmer.status).toBe("error");
    expect(state().programmer.error).toBe("minipro isn't installed");
  });

  it("lets the user choose a model while nothing is plugged in", async () => {
    const { controller, state, fake } = setup({ programmer: null });
    await controller.detect();
    expect(activeProgrammer(state())).toBe("t48");
    const searchChips = vi.spyOn(fake, "searchChips");
    controller.chooseProgrammer("t76");
    expect(activeProgrammer(state())).toBe("t76");
    controller.setQuery("flash");
    expect(searchChips).toHaveBeenLastCalledWith("t76", "flash", 30);
  });

  it("goes by the detected programmer, not the one chosen by hand", async () => {
    const { controller, state } = setup();
    controller.chooseProgrammer("tl866a");
    expect(activeProgrammer(state())).toBe("tl866a");
    await controller.detect();
    expect(activeProgrammer(state())).toBe("t48");
  });

  it("keeps the picker on the last detected model after it's unplugged", async () => {
    const { controller, state, fake } = setup({
      programmer: {
        programmer: "T76",
        firmware: "00.1.17",
        chip: null,
        firmware_status: null,
        firmware_expected: null,
        support_warning: null,
      },
    });
    await controller.detect();
    expect(activeProgrammer(state())).toBe("t76");
    fake.programmer = null;
    await controller.detect();
    expect(state().programmer.status).toBe("none");
    expect(activeProgrammer(state())).toBe("t76");
  });

  it("searches again and looks the chip up again when the list changes", async () => {
    const { controller, state, fake } = setup({ programmer: null });
    await controller.detect();
    controller.selectChip({ name: "EEPROM16", package: null });
    controller.setQuery("flash");
    await soon(() => expect(state().chip.search.status).toBe("ready"));
    const searchChips = vi.spyOn(fake, "searchChips");
    const chipInfo = vi.spyOn(fake, "chipInfo");
    controller.chooseProgrammer("tl866a");
    expect(state().chip.search.status).toBe("loading");
    expect(searchChips).toHaveBeenCalledWith("tl866a", "flash", 30);
    expect(chipInfo).toHaveBeenCalledWith("tl866a", "EEPROM16");
    await soon(() => expect(selectedInfo(state())?.name).toBe("EEPROM16"));
  });
});

const T76: DeviceInfo = {
  programmer: "T76",
  firmware: "00.1.17",
  chip: null,
  firmware_status: null,
  firmware_expected: null,
  support_warning: "T76 support is experimental!",
};
const DEFAULT_ALGORITHMS = "/usr/local/share/minipro/algorithm.xml";
const MY_ALGORITHMS = "/home/me/xgecu/algorithm.xml";

/** A localStorage stand-in. */
function memoryStorage() {
  const stored = new Map<string, string>();
  return {
    stored,
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  };
}

describe("algorithm file", () => {
  const t76 = (options: FakeEngineOptions = {}) => ({
    programmer: T76,
    socket: socketWith("FLASH32@SOIC8", ramp(32)),
    algorithmFiles: [MY_ALGORITHMS],
    ...options,
  });

  it("looks for a T76's algorithm file at detect, and for no other programmer's", async () => {
    const { controller, state, commands } = setup(t76());
    expect(state().algorithms).toBeNull();
    await controller.detect();
    expect(commands()).toEqual(["detect", "algorithmFile"]);
    expect(state().algorithms).toEqual({
      configured: null,
      found: null,
      default_path: DEFAULT_ALGORITHMS,
    });

    const t48 = setup();
    await t48.controller.detect();
    expect(t48.commands()).toEqual(["detect"]);
    expect(t48.state().algorithms).toBeNull();
  });

  it("says in plain words why a T76 operation failed without the file", async () => {
    const { controller, state, ready, idle } = setup(t76());
    await ready("FLASH32@SOIC8");
    controller.run("check");
    await idle();
    expect(state().outcome).toEqual({
      op: "check",
      chip: "FLASH32@SOIC8",
      tone: "error",
      title: "No algorithm file for the T76",
      details: [
        `minipro can't open the algorithm file: ${DEFAULT_ALGORITHMS}: No such file or directory.`,
        "The T76 needs XGecu's algorithm.xml, a file from the Xgpro package, before it can work on a chip. burnwright doesn't ship or download it.",
        "minipro stopped before any read or write: nothing on the chip changed.",
        'Pick your own copy with "Choose file…" under Algorithm file in the Programmer panel, or put it at the path above.',
      ],
      retry: null,
    });
    // minipro's own lines are in the log, and so is the explanation.
    const log = logText(state().log);
    expect(log).toContain(`${DEFAULT_ALGORITHMS}: No such file or directory`);
    expect(log).toContain("An error occurred while sending bitstream.");
    expect(log).toContain("No algorithm file for the T76: minipro can't open");
  });

  it("fails every operation the same way, and changes nothing on the chip", async () => {
    const { controller, state, fake, ready, idle, dialogs } = setup(
      t76({ files: { "/image.bin": ramp(32, 100) } }),
    );
    await ready("FLASH32@SOIC8");
    const before = Array.from(fake.socket?.memory ?? []);
    for (const op of ["read", "blank_check"] as const) {
      controller.run(op);
      await idle();
      expect(state().outcome?.title, op).toBe("No algorithm file for the T76");
    }
    expect(state().buffer).toBeNull();
    dialogs.open.mockResolvedValue("/image.bin");
    await controller.openFile();
    for (const op of ["verify", "erase", "write"] as const) {
      controller.run(op);
      if (state().confirm) controller.confirm();
      await idle();
      expect(state().outcome?.title, op).toBe("No algorithm file for the T76");
      expect(state().outcome?.retry, op).toBeNull();
    }
    expect(Array.from(fake.socket?.memory ?? [])).toEqual(before);
  });

  it("passes the file the user chooses, and the operation then runs", async () => {
    const storage = memoryStorage();
    const { controller, state, fake, dialogs, ready, idle } = setup(
      t76(),
      settingsStore(storage),
    );
    await ready("FLASH32@SOIC8");
    dialogs.openAlgorithms.mockResolvedValue(MY_ALGORITHMS);
    await controller.chooseAlgorithmFile();
    expect(fake.algorithmPath).toBe(MY_ALGORITHMS);
    expect(state().algorithms).toEqual({
      configured: MY_ALGORITHMS,
      found: MY_ALGORITHMS,
      default_path: DEFAULT_ALGORITHMS,
    });
    expect(storage.stored.get("burnwright.algorithmPath")).toBe(MY_ALGORITHMS);
    expect(logText(state().log)).toContain(`Algorithm file set to ${MY_ALGORITHMS}.`);

    controller.run("check");
    await idle();
    expect(state().outcome?.title).toBe("Chip check passed");
  });

  it("leaves things alone when the file panel is dismissed", async () => {
    const { controller, state, fake, commands } = setup(t76());
    await controller.detect();
    await controller.chooseAlgorithmFile();
    expect(fake.algorithmPath).toBeNull();
    expect(commands()).not.toContain("setAlgorithmPath");
    expect(state().algorithms?.configured).toBeNull();
  });

  it("hands the remembered file back to the engine before the first detect", async () => {
    const storage = memoryStorage();
    settingsStore(storage).saveAlgorithmPath(MY_ALGORITHMS);
    const { controller, state, fake, commands } = setup(t76(), settingsStore(storage));
    await controller.detect();
    expect(commands()).toEqual(["setAlgorithmPath", "detect", "algorithmFile"]);
    expect(fake.algorithmPath).toBe(MY_ALGORITHMS);
    expect(state().algorithms?.found).toBe(MY_ALGORITHMS);
  });

  it("names a chosen file that has gone missing", async () => {
    const storage = memoryStorage();
    settingsStore(storage).saveAlgorithmPath("/gone/algorithm.xml");
    const { controller, state, ready, idle } = setup(t76(), settingsStore(storage));
    await ready("FLASH32@SOIC8");
    expect(state().algorithms).toEqual({
      configured: "/gone/algorithm.xml",
      found: null,
      default_path: DEFAULT_ALGORITHMS,
    });
    controller.run("check");
    await idle();
    expect(state().outcome?.details[0]).toBe(
      "minipro can't open the algorithm file: /gone/algorithm.xml: No such file or directory.",
    );
  });

  it("clears the choice and forgets it", async () => {
    const storage = memoryStorage();
    settingsStore(storage).saveAlgorithmPath(MY_ALGORITHMS);
    const { controller, state, fake } = setup(t76(), settingsStore(storage));
    await controller.detect();
    await controller.clearAlgorithmFile();
    expect(fake.algorithmPath).toBeNull();
    expect(storage.stored.has("burnwright.algorithmPath")).toBe(false);
    expect(state().algorithms).toEqual({
      configured: null,
      found: null,
      default_path: DEFAULT_ALGORITHMS,
    });
    expect(logText(state().log)).toContain("Algorithm file choice cleared.");
  });

  it("doesn't change the file while an operation runs", async () => {
    const { controller, fake, dialogs, ready, idle } = setup(
      t76({ algorithmFile: DEFAULT_ALGORITHMS }),
    );
    await ready("FLASH32@SOIC8");
    fake.hold();
    controller.run("read");
    dialogs.openAlgorithms.mockResolvedValue(MY_ALGORITHMS);
    await controller.chooseAlgorithmFile();
    await controller.clearAlgorithmFile();
    expect(dialogs.openAlgorithms).not.toHaveBeenCalled();
    expect(fake.algorithmPath).toBeNull();
    fake.release();
    await idle();
  });

  it("says when the file opened and has nothing for the chip", async () => {
    const { controller, state, fake, ready, idle } = setup(
      t76({ algorithmFile: DEFAULT_ALGORITHMS }),
    );
    await ready("FLASH32@SOIC8");
    fake.failNext({
      kind: "unusable_algorithms",
      message: "minipro can't use the algorithm file: No algorithm SPI25F11 was found.",
      device_state: null,
    });
    controller.run("read");
    await idle();
    expect(state().outcome).toEqual({
      op: "read",
      chip: "FLASH32@SOIC8",
      tone: "error",
      title: "minipro can't use the algorithm file",
      details: [
        "minipro can't use the algorithm file: No algorithm SPI25F11 was found.",
        "The file opened, but minipro couldn't get what FLASH32@SOIC8 needs from it. It may come from a different Xgpro version than this T76's firmware goes with, be made for another programmer, be damaged, or not be an algorithm.xml at all.",
        "minipro stopped before any read or write: nothing on the chip changed.",
        'Pick another file with "Choose file…" under Algorithm file in the Programmer panel.',
      ],
      retry: null,
    });
  });

  it("doesn't point a T56 at a control it doesn't have", async () => {
    const { controller, state, fake, ready, idle } = setup({
      programmer: { ...T76, programmer: "T56", support_warning: null },
      socket: socketWith("FLASH32@SOIC8", ramp(32)),
    });
    await ready("FLASH32@SOIC8");
    fake.failNext({
      kind: "missing_algorithms",
      message: `minipro can't open the algorithm file: ${DEFAULT_ALGORITHMS}: No such file or directory`,
      device_state: null,
    });
    controller.run("read");
    await idle();
    expect(state().outcome?.title).toBe("No algorithm file for the T56");
    expect(last(state().outcome?.details ?? [])).toBe("Put your own copy at the path above.");
  });
});

describe("chip picker", () => {
  it("searches as the user types and fills in each result's size", async () => {
    const { controller, state } = setup();
    controller.setQuery("32");
    expect(state().chip.search.status).toBe("loading");
    await soon(() => expect(state().chip.search.status).toBe("ready"));
    expect(state().chip.search.results.map((c) => c.name)).toEqual([
      "FLASH32@SOIC8",
      "OTHER32@SOIC8",
    ]);
    expect(state().chip.search.total).toBe(2);
    await soon(() =>
      expect(lookupFor(state(), "OTHER32@SOIC8")?.status).toBe("ready"),
    );
    expect(lookupFor(state(), "FLASH32@SOIC8")).toMatchObject({
      status: "ready",
      info: { memory: { bytes: 32 } },
    });
  });

  it("doesn't look a chip up twice", async () => {
    const { controller, state, fake } = setup();
    controller.setQuery("flash");
    await soon(() =>
      expect(lookupFor(state(), "FLASH32@SOIC8")?.status).toBe("ready"),
    );
    controller.setQuery("flash3");
    await soon(() => expect(state().chip.search.query).toBe("flash3"));
    await Promise.resolve();
    expect(fake.calls.filter((c) => c.command === "chipInfo")).toHaveLength(1);
  });

  it("drops the answer to a query that has changed since", async () => {
    const { controller, state, fake } = setup();
    let answerFirst: (value: { total: number; chips: [] }) => void = () => {};
    const real = fake.searchChips;
    fake.searchChips = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerFirst = resolve;
          }),
      )
      .mockImplementation(real);
    controller.setQuery("fla");
    controller.setQuery("eeprom");
    await soon(() => expect(state().chip.search.status).toBe("ready"));
    answerFirst({ total: 0, chips: [] });
    await Promise.resolve();
    expect(state().chip.search.results.map((c) => c.name)).toEqual(["EEPROM16"]);
  });

  it("clears the results when the box is emptied", async () => {
    const { controller, state } = setup();
    controller.setQuery("flash");
    await soon(() => expect(state().chip.search.status).toBe("ready"));
    controller.setQuery("  ");
    expect(state().chip.search).toMatchObject({ status: "idle", results: [] });
  });

  it("reports a search that fails", async () => {
    const { controller, state, fake } = setup();
    fake.searchChips = () =>
      Promise.reject({
        kind: "missing_database",
        message: "minipro can't read its chip database: /x/infoic.xml: No such file",
        device_state: null,
      });
    controller.setQuery("flash");
    await soon(() => expect(state().chip.search.status).toBe("error"));
    expect(state().chip.search.error).toContain("/x/infoic.xml");
  });

  it("selects a chip, loads its details and remembers it", async () => {
    const { controller, state } = setup();
    controller.setQuery("flash");
    controller.selectChip({ name: "FLASH32@SOIC8", package: "SOIC8" });
    expect(state().chip.selected).toEqual({ name: "FLASH32@SOIC8", package: "SOIC8" });
    expect(state().chip.query).toBe("");
    expect(selectedLookup(state())).toEqual({ status: "loading" });
    await soon(() => expect(selectedInfo(state())?.name).toBe("FLASH32@SOIC8"));
    expect(state().chip.recent).toEqual([
      { name: "FLASH32@SOIC8", package: "SOIC8", programmer: "t48" },
    ]);
  });

  it("keeps recent chips newest first, once each, across runs", () => {
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    };
    const first = new DeviceController({
      engine: createFakeEngine({ chips: CHIPS }),
      dialogs: { open: async () => null, save: async () => null, openAlgorithms: async () => null },
      recent: recentStore(storage),
    });
    first.selectChip({ name: "EEPROM16", package: null });
    first.selectChip({ name: "FLASH32@SOIC8", package: "SOIC8" });
    first.selectChip({ name: "EEPROM16", package: null });
    const second = new DeviceController({
      engine: createFakeEngine({ chips: CHIPS }),
      dialogs: { open: async () => null, save: async () => null, openAlgorithms: async () => null },
      recent: recentStore(storage),
    });
    expect(second.getState().chip.recent.map((c) => c.name)).toEqual([
      "EEPROM16",
      "FLASH32@SOIC8",
    ]);
  });

  it("shows minipro's message for an entry it can't read", async () => {
    const { ready, state } = setup();
    await ready("AT28C256E");
    expect(selectedLookup(state())).toEqual({
      status: "error",
      kind: "minipro",
      message:
        "minipro can't read its database entry for AT28C256E: An error occurred while parsing XML database.",
    });
    expect(operationAvailability(state(), "read")).toEqual({
      enabled: false,
      reason: "burnwright has no details for AT28C256E, so it can't work on it.",
    });
  });

  it("turns the memory operations off for a logic IC, and says why", async () => {
    const { ready, state, controller, commands } = setup({
      socket: socketWith("7400", bytes()),
    });
    await ready("7400");
    for (const op of ["read", "verify", "blank_check", "erase", "write", "check"] as const) {
      const availability = operationAvailability(state(), op);
      expect(availability.enabled).toBe(false);
      expect(availability.reason).toMatch(/7400 is a logic IC/);
      controller.run(op);
    }
    expect(state().running).toBeNull();
    expect(state().confirm).toBeNull();
    expect(commands()).not.toContain("read");
  });
});

describe("buffer", () => {
  it("opens a file into the buffer", async () => {
    const { controller, state, dialogs } = setup({
      files: { "/tmp/image.bin": ramp(16) },
    });
    dialogs.open.mockResolvedValue("/tmp/image.bin");
    await controller.openFile();
    expect(state().buffer).toMatchObject({
      bytes: ramp(16),
      edited: false,
      source: { kind: "file", path: "/tmp/image.bin" },
      path: "/tmp/image.bin",
    });
    expect(unsavedBuffer(state().buffer)).toBeNull();
  });

  it("leaves the buffer alone when the open dialog is dismissed", async () => {
    const { controller, state, commands } = setup();
    await controller.openFile();
    expect(state().buffer).toBeNull();
    expect(commands()).not.toContain("loadImage");
  });

  it("says why a file wouldn't open, and keeps the buffer", async () => {
    const { controller, state, dialogs } = setup({ files: { "/a.bin": ramp(4) } });
    dialogs.open.mockResolvedValueOnce("/a.bin").mockResolvedValueOnce("/nope/b.hex");
    await controller.openFile();
    await controller.openFile();
    expect(state().fileError).toBe(
      "Couldn't open b.hex: /nope/b.hex: No such file or directory (os error 2)",
    );
    expect(state().buffer?.bytes).toEqual(ramp(4));
  });

  it("saves to the open file, and asks where for a read", async () => {
    const { controller, state, dialogs, fake, ready, idle } = setup({
      files: { "/a.bin": ramp(4) },
      socket: socketWith("EEPROM16", ramp(16, 0x40)),
    });
    dialogs.open.mockResolvedValue("/a.bin");
    await controller.openFile();
    controller.editBuffer(bytes(9, 1, 2, 3), true);
    expect(unsavedBuffer(state().buffer)).toBe("edits");
    await controller.save();
    expect(dialogs.save).not.toHaveBeenCalled();
    expect(fake.saved["/a.bin"]).toEqual(bytes(9, 1, 2, 3));
    expect(unsavedBuffer(state().buffer)).toBeNull();

    await ready("EEPROM16");
    controller.run("read");
    await idle();
    dialogs.save.mockResolvedValue("/out/dump.bin");
    await controller.save();
    expect(dialogs.save).toHaveBeenCalledWith("EEPROM16.bin");
    expect(fake.saved["/out/dump.bin"]).toEqual(ramp(16, 0x40));
    expect(state().buffer?.path).toBe("/out/dump.bin");
  });

  it("saves under a new name with Save as", async () => {
    const { controller, state, dialogs, fake } = setup({ files: { "/a.bin": ramp(4) } });
    dialogs.open.mockResolvedValue("/a.bin");
    await controller.openFile();
    dialogs.save.mockResolvedValue("/b.hex");
    await controller.saveAs();
    expect(dialogs.save).toHaveBeenCalledWith("/a.bin");
    expect(fake.saved["/b.hex"]).toEqual(ramp(4));
    expect(state().buffer?.path).toBe("/b.hex");
  });

  it("counts edits undone after a save as unsaved again", async () => {
    const { controller, state, dialogs } = setup({ files: { "/a.bin": ramp(4) } });
    dialogs.open.mockResolvedValue("/a.bin");
    await controller.openFile();
    controller.editBuffer(bytes(9, 1, 2, 3), true);
    await controller.save();
    // Undo: the bytes are the originals again, which the file no longer holds.
    controller.editBuffer(ramp(4), false);
    expect(unsavedBuffer(state().buffer)).toBe("edits");
  });

  it("asks before a file replaces unsaved edits", async () => {
    const { controller, state, dialogs } = setup({
      files: { "/a.bin": ramp(4), "/b.bin": ramp(8) },
    });
    dialogs.open.mockResolvedValue("/a.bin");
    await controller.openFile();
    controller.editBuffer(bytes(9, 1, 2, 3), true);
    dialogs.open.mockClear();
    dialogs.open.mockResolvedValue("/b.bin");

    await controller.openFile();
    expect(state().confirm).toMatchObject({ kind: "replace_buffer", by: "file" });
    expect(dialogs.open).not.toHaveBeenCalled();
    controller.dismissConfirm();
    expect(state().buffer?.bytes).toEqual(bytes(9, 1, 2, 3));

    await controller.openFile();
    controller.confirm();
    await soon(() => expect(state().buffer?.bytes).toEqual(ramp(8)));
  });
});

describe("operations", () => {
  it("reads, edits, writes and verifies", async () => {
    const chip = ramp(16, 0x10);
    const { controller, state, ready, idle, fake } = setup({
      socket: socketWith("EEPROM16", chip),
    });
    await ready("EEPROM16");

    controller.run("read");
    expect(state().running).toMatchObject({ op: "read", chip: "EEPROM16" });
    await idle();
    expect(state().buffer?.bytes).toEqual(ramp(16, 0x10));
    expect(state().buffer?.source).toEqual({ kind: "chip", chip: "EEPROM16" });
    expect(state().outcome).toMatchObject({ tone: "ok", title: "Read EEPROM16" });
    expect(bufferSizeCheck(state())).toEqual({ status: "match", bytes: 16 });

    const edited = ramp(16, 0x10);
    edited[3] = 0xaa;
    controller.editBuffer(edited, true);

    controller.run("write");
    // Nothing happens to the chip until the user says so.
    expect(state().confirm).toEqual({
      kind: "write",
      chip: "EEPROM16",
      overrides: { ignoreChipId: false, ignoreSize: false },
    });
    expect(state().running).toBeNull();
    expect(fake.calls.some((c) => c.command === "write")).toBe(false);
    controller.confirm();
    expect(state().confirm).toBeNull();
    await idle();
    expect(state().outcome).toMatchObject({ tone: "ok", title: "Wrote EEPROM16" });
    expect(fake.socket?.memory).toEqual(edited);
    expect(last(fake.calls)).toEqual({
      command: "write",
      part: "EEPROM16",
      options: { ignoreChipId: false, ignoreSize: false },
    });

    controller.run("verify");
    await idle();
    expect(state().outcome).toMatchObject({ tone: "ok", title: "Verify passed" });
    expect(state().diff).toBeNull();
  });

  it("backs out of a write when the confirmation is dismissed", async () => {
    const { controller, state, ready, idle, fake } = setup({
      socket: socketWith("EEPROM16", ramp(16)),
    });
    await ready("EEPROM16");
    controller.run("read");
    await idle();
    controller.run("write");
    controller.dismissConfirm();
    expect(state().confirm).toBeNull();
    expect(state().running).toBeNull();
    expect(fake.calls.some((c) => c.command === "write")).toBe(false);
  });

  it("reports progress while an operation runs", async () => {
    const { controller, state, ready, idle, fake } = setup({
      socket: socketWith("EEPROM16", ramp(16)),
      steps: 4,
    });
    await ready("EEPROM16");
    fake.hold();
    controller.run("read");
    await soon(() => expect(state().running?.stage).toBe("Reading Code"));
    expect(state().running?.percent).toBeNull();
    fake.release();
    await idle();
    expect(logText(state().log)).toContain("Reading Code: done in 0.5 s");
  });

  it("needs a buffer for verify and write, a chip for everything, a programmer first", async () => {
    const { controller, state } = setup({ socket: socketWith("EEPROM16", ramp(16)) });
    expect(operationAvailability(state(), "read").reason).toBe("No programmer detected.");
    await controller.detect();
    expect(operationAvailability(state(), "read").reason).toBe("Pick a chip first.");
    controller.selectChip({ name: "EEPROM16", package: null });
    expect(operationAvailability(state(), "read").reason).toBe(
      "Loading the chip's details.",
    );
    await soon(() => expect(selectedInfo(state())).not.toBeNull());
    expect(operationAvailability(state(), "read").enabled).toBe(true);
    expect(operationAvailability(state(), "erase").enabled).toBe(true);
    expect(operationAvailability(state(), "write").reason).toBe(
      "Open a file or read a chip first: the buffer is empty.",
    );
    controller.run("write");
    expect(state().confirm).toBeNull();
  });

  it("runs one operation at a time", async () => {
    const { controller, state, ready, idle, fake } = setup({
      socket: socketWith("EEPROM16", ramp(16)),
    });
    await ready("EEPROM16");
    fake.hold();
    controller.run("read");
    expect(operationAvailability(state(), "blank_check").reason).toBe(
      "Another operation is running.",
    );
    controller.run("blank_check");
    controller.selectChip({ name: "FLASH32@SOIC8", package: "SOIC8" });
    await controller.detect();
    expect(state().chip.selected?.name).toBe("EEPROM16");
    fake.release();
    await idle();
    expect(fake.calls.map((c) => c.command).filter((c) => c !== "chipInfo")).toEqual([
      "detect",
      "read",
    ]);
  });

  it("blank-checks and erases, asking before the erase", async () => {
    const { controller, state, ready, idle, fake } = setup({
      socket: socketWith("EEPROM16", ramp(16)),
    });
    await ready("EEPROM16");
    controller.run("blank_check");
    await idle();
    expect(state().outcome).toMatchObject({ tone: "warning", title: "Chip is not blank" });

    controller.run("erase");
    expect(state().confirm).toMatchObject({ kind: "erase", chip: "EEPROM16" });
    expect(fake.calls.some((c) => c.command === "erase")).toBe(false);
    controller.confirm();
    await idle();
    expect(state().outcome).toMatchObject({ tone: "ok", title: "Erased EEPROM16" });
    expect(fake.socket?.memory.every((b) => b === 0xff)).toBe(true);

    controller.run("blank_check");
    await idle();
    expect(state().outcome).toMatchObject({ tone: "ok", title: "Chip is blank" });
  });

  it("logs the command line and minipro's output for each operation", async () => {
    const { controller, state, ready, idle } = setup({
      socket: socketWith("FLASH32@SOIC8", ramp(32)),
    });
    await ready("FLASH32@SOIC8");
    controller.run("read");
    await idle();
    const text = logText(state().log);
    expect(text).toContain("== Detect programmer ==\n$ minipro -k");
    expect(text).toContain(
      "== Read FLASH32@SOIC8 ==\n$ minipro -p FLASH32@SOIC8 -c code -r -\nFound T48 01.1.32\nChip ID: 0xEF4016  OK\nReading Code...",
    );
    expect(text).toContain("Read FLASH32@SOIC8: 32 bytes from the chip are in the buffer.");
    controller.clearLog();
    expect(state().log).toEqual([]);
  });

  it("marks the programmer as gone when an operation finds none", async () => {
    const { controller, state, ready, idle, fake } = setup({
      socket: socketWith("EEPROM16", ramp(16)),
    });
    await ready("EEPROM16");
    fake.programmer = null;
    controller.run("read");
    await idle();
    expect(state().outcome).toMatchObject({
      tone: "error",
      title: "The programmer didn't answer",
    });
    await soon(() => expect(state().programmer.status).toBe("none"));
    expect(operationAvailability(state(), "read").reason).toBe("No programmer detected.");
  });

  it("reports any other failure with minipro's words", async () => {
    const { controller, state, ready, idle } = setup({ socket: null });
    await ready("EEPROM16");
    controller.run("read");
    await idle();
    expect(state().outcome).toMatchObject({
      tone: "error",
      title: "Read failed",
      details: ["Overcurrent protection!"],
      retry: null,
    });
    expect(state().buffer).toBeNull();
  });
});

describe("size mismatches", () => {
  async function withBuffer(length: number, chip = "EEPROM16") {
    const context = setup({
      files: { "/image.bin": ramp(length, 0x80) },
      socket: socketWith(chip, new Uint8Array(16).fill(0xff)),
    });
    context.dialogs.open.mockResolvedValue("/image.bin");
    await context.controller.openFile();
    await context.ready(chip);
    return context;
  }

  const copyFor = (state: ReturnType<DeviceController["getState"]>) => {
    if (!state.confirm) throw new Error("no confirmation is open");
    return confirmCopy(state.confirm, {
      size: bufferSizeCheck(state),
      bufferLength: state.buffer?.bytes.length ?? null,
      availability: null,
    });
  };

  it("shows a short buffer before the write and sends it as it is", async () => {
    const { controller, state, idle, fake } = await withBuffer(10);
    expect(bufferSizeCheck(state())).toEqual({ status: "short", buffer: 10, chip: 16 });
    controller.run("write");
    const copy = copyFor(state());
    expect(copy.title).toBe("Write to EEPROM16?");
    expect(copy.paragraphs.join(" ")).toContain(
      "The buffer is 10 bytes and the chip holds 16 bytes: 6 bytes short. burnwright won't pad it.",
    );
    expect(copy.confirm).toBe("Write EEPROM16 anyway");
    expect(fake.calls.some((c) => c.command === "write")).toBe(false);

    controller.confirm();
    await idle();
    expect(last(fake.calls)).toMatchObject({
      command: "write",
      options: { ignoreSize: true },
    });
    // The 10 bytes went on; the buffer itself is still 10 bytes.
    expect(Array.from(fake.socket?.memory ?? [])).toEqual([
      ...ramp(10, 0x80),
      ...new Array(6).fill(0xff),
    ]);
    expect(state().buffer?.bytes).toEqual(ramp(10, 0x80));
    expect(state().outcome?.details.join(" ")).toContain("The size check was off");
  });

  it("shows a long buffer before the write and never cuts it down", async () => {
    const { controller, state, idle, fake } = await withBuffer(20);
    expect(bufferSizeCheck(state())).toEqual({ status: "long", buffer: 20, chip: 16 });
    controller.run("write");
    expect(copyFor(state()).paragraphs.join(" ")).toContain(
      "4 bytes too many. burnwright won't cut it down.",
    );
    controller.dismissConfirm();
    expect(fake.calls.some((c) => c.command === "write")).toBe(false);

    controller.run("write");
    controller.confirm();
    await idle();
    expect(fake.socket?.memory).toEqual(ramp(16, 0x80));
    expect(state().buffer?.bytes).toEqual(ramp(20, 0x80));
  });

  it("asks before verifying a buffer of the wrong size", async () => {
    const { controller, state, idle, fake } = await withBuffer(10);
    fake.socket?.memory.set(ramp(10, 0x80));
    controller.run("verify");
    expect(state().confirm).toMatchObject({ kind: "verify_size" });
    expect(copyFor(state()).paragraphs[0]).toContain(
      "the last 6 bytes of the chip are not checked",
    );
    expect(fake.calls.some((c) => c.command === "verify")).toBe(false);
    controller.confirm();
    await idle();
    expect(last(fake.calls)).toMatchObject({
      command: "verify",
      options: { ignoreSize: true },
    });
    expect(state().outcome?.details[0]).toContain("over the bytes both have");
  });

  it("says plainly when there is no size to check, and doesn't turn minipro's check off", async () => {
    for (const [chip, why] of [
      ["NAND@SOP16", "not_given"],
      ["GAL16V8D", "bits"],
    ] as const) {
      const { controller, state, idle, fake } = await withBuffer(10, chip);
      expect(bufferSizeCheck(state())).toEqual({ status: "unknown", why });
      expect(operationAvailability(state(), "write").enabled).toBe(true);
      controller.run("write");
      const copy = copyFor(state());
      expect(copy.paragraphs.join(" ")).toContain(
        "burnwright hasn't checked the buffer against it",
      );
      expect(copy.confirm).toBe(`Write ${chip}`);
      controller.confirm();
      await idle();
      expect(last(fake.calls)).toMatchObject({
        command: "write",
        options: { ignoreSize: false },
      });
    }
  });

  it("offers minipro's own override when minipro rejects the size", async () => {
    const { controller, state, idle, fake } = await withBuffer(10, "NAND@SOP16");
    fake.failNext({
      kind: "size_mismatch",
      message: "the image is 10 bytes and the chip takes 64",
      device_state: null,
    });
    controller.run("write");
    controller.confirm();
    await idle();
    expect(state().outcome).toMatchObject({
      tone: "error",
      title: "Buffer is the wrong size",
      retry: {
        label: "Write anyway, ignoring the size",
        overrides: { ignoreChipId: false, ignoreSize: true },
      },
    });
    expect(state().outcome?.details[0]).toBe(
      "The image is 10 bytes and the chip takes 64.",
    );

    controller.retry();
    // Still a write: it asks again.
    expect(state().confirm).toMatchObject({
      kind: "write",
      overrides: { ignoreSize: true },
    });
    // And the dialog says what will happen now, not what would have.
    const copy = copyFor(state());
    expect(copy.paragraphs.join(" ")).toContain("minipro is told to ignore the size");
    expect(copy.paragraphs.join(" ")).not.toContain("stops if the size is wrong");
    expect(copy.confirm).toBe("Write NAND@SOP16 anyway");
    controller.confirm();
    await idle();
    expect(last(fake.calls)).toMatchObject({
      command: "write",
      options: { ignoreSize: true },
    });
  });
});

describe("chip ID and pin contact", () => {
  it("reports a chip ID mismatch as its own error and can read past it", async () => {
    const { controller, state, ready, idle, fake } = setup({
      socket: socketWith("OTHER32@SOIC8", ramp(32)),
    });
    await ready("FLASH32@SOIC8");
    controller.run("read");
    await idle();
    expect(state().outcome).toMatchObject({
      tone: "error",
      title: "Chip ID mismatch",
      retry: {
        label: "Read anyway, ignoring the chip ID",
        overrides: { ignoreChipId: true, ignoreSize: false },
      },
    });
    expect(state().outcome?.details[0]).toBe(
      "Expected 0xEF4016, found 0xC22016 (OTHER32@SOIC8).",
    );
    expect(state().buffer).toBeNull();

    controller.retry();
    await idle();
    expect(last(fake.calls)).toMatchObject({
      command: "read",
      options: { ignoreChipId: true },
    });
    expect(state().buffer?.bytes).toEqual(ramp(32));
  });

  it("asks again before writing past a chip ID mismatch", async () => {
    const { controller, state, ready, idle, fake, dialogs } = setup({
      files: { "/image.bin": ramp(32, 5) },
      socket: socketWith("OTHER32@SOIC8", new Uint8Array(32)),
    });
    dialogs.open.mockResolvedValue("/image.bin");
    await controller.openFile();
    await ready("FLASH32@SOIC8");
    controller.run("write");
    controller.confirm();
    await idle();
    expect(state().outcome?.title).toBe("Chip ID mismatch");
    expect(fake.socket?.memory).toEqual(new Uint8Array(32));

    controller.retry();
    expect(state().confirm).toEqual({
      kind: "write",
      chip: "FLASH32@SOIC8",
      overrides: { ignoreChipId: true, ignoreSize: false },
    });
    const copy = confirmCopy(state().confirm!, {
      size: bufferSizeCheck(state()),
      bufferLength: 32,
      availability: null,
    });
    expect(copy.paragraphs.join(" ")).toContain("the chip's ID doesn't match");
    expect(copy.confirm).toBe("Write FLASH32@SOIC8 anyway");
    expect(fake.calls.filter((c) => c.command === "write")).toHaveLength(1);

    controller.confirm();
    await idle();
    expect(fake.socket?.memory).toEqual(ramp(32, 5));
  });

  it("checks the chip's ID without touching its memory", async () => {
    const { controller, state, ready, idle, fake } = setup({
      socket: socketWith("FLASH32@SOIC8", ramp(32)),
    });
    await ready("FLASH32@SOIC8");
    controller.run("check");
    await idle();
    expect(state().outcome).toMatchObject({
      tone: "ok",
      title: "Chip check passed",
      details: ["The chip ID is 0xEF4016, as FLASH32@SOIC8 should have."],
    });
    // The T48 can't test pin contact, so it isn't asked to.
    expect(last(fake.calls)).toMatchObject({ command: "checkChip", pinCheck: false });

    fake.socket = socketWith("OTHER32@SOIC8", ramp(32));
    controller.run("check");
    await idle();
    expect(state().outcome).toMatchObject({ tone: "error", title: "Chip ID mismatch" });
    expect(state().outcome?.details[0]).toBe(
      "FLASH32@SOIC8 should answer with ID 0xEF4016. The chip in the socket answers 0xC22016, which minipro knows as OTHER32@SOIC8.",
    );
  });

  it("reports bad pin contact on a TL866II+", async () => {
    const { controller, state, ready, idle, fake } = setup({
      programmer: {
        programmer: "TL866II+",
        firmware: "04.2.132",
        chip: null,
        firmware_status: null,
        firmware_expected: null,
        support_warning: null,
      },
      socket: { chip: "FLASH32@SOIC8", memory: ramp(32), badPins: [3, 17] },
    });
    await ready("FLASH32@SOIC8");
    controller.run("check");
    await idle();
    expect(last(fake.calls)).toMatchObject({ command: "checkChip", pinCheck: true });
    expect(state().outcome).toMatchObject({ tone: "error", title: "Bad pin contact" });
    expect(state().outcome?.details[0]).toBe(
      "Pins 3 and 17 of the socket don't make contact. Reseat the chip, check that it's the right way round, and check again.",
    );
  });

  it("says when a chip has no ID to check", async () => {
    const { controller, state, ready, idle } = setup({
      socket: socketWith("EEPROM16", ramp(16)),
    });
    await ready("EEPROM16");
    controller.run("check");
    await idle();
    expect(state().outcome).toMatchObject({ tone: "ok", title: "Nothing to check" });
  });
});

describe("cancelling", () => {
  it("stops a read straight away: nothing on the chip changes", async () => {
    const { controller, state, ready, idle, fake } = setup({
      socket: socketWith("EEPROM16", ramp(16)),
    });
    await ready("EEPROM16");
    fake.hold();
    controller.run("read");
    controller.requestCancel();
    expect(state().confirm).toBeNull();
    expect(state().running?.cancelling).toBe(true);
    fake.release();
    await idle();
    expect(state().outcome).toMatchObject({
      tone: "warning",
      title: "Read cancelled",
      details: ["Nothing on the chip changed."],
    });
    expect(state().buffer).toBeNull();
  });

  it("asks before stopping a write, and warns that the chip is half-programmed", async () => {
    const { controller, state, ready, idle, fake, dialogs } = setup({
      files: { "/image.bin": ramp(16, 0x20) },
      socket: socketWith("EEPROM16", new Uint8Array(16)),
    });
    dialogs.open.mockResolvedValue("/image.bin");
    await controller.openFile();
    await ready("EEPROM16");
    fake.hold();
    controller.run("write");
    controller.confirm();
    expect(state().running?.op).toBe("write");

    controller.requestCancel();
    expect(state().confirm).toEqual({ kind: "cancel", op: "write", chip: "EEPROM16" });
    expect(state().running?.cancelling).toBe(false);
    // "Keep writing": the write goes on.
    controller.dismissConfirm();
    expect(state().running?.cancelling).toBe(false);

    controller.requestCancel();
    controller.confirm();
    expect(state().confirm).toBeNull();
    expect(state().running?.cancelling).toBe(true);
    fake.release();
    await idle();
    expect(state().outcome).toMatchObject({
      tone: "error",
      title: "Write cancelled",
      details: [
        "EEPROM16 may be half-programmed. Erase it or write it again before trusting what's on it.",
      ],
    });
  });

  it("asks before stopping an erase", async () => {
    const { controller, state, ready, idle, fake } = setup({
      socket: socketWith("EEPROM16", ramp(16)),
    });
    await ready("EEPROM16");
    fake.hold();
    controller.run("erase");
    controller.confirm();
    controller.requestCancel();
    expect(state().confirm).toEqual({ kind: "cancel", op: "erase", chip: "EEPROM16" });
    controller.confirm();
    fake.release();
    await idle();
    expect(state().outcome?.details[0]).toContain("may be half-erased");
  });

  it("drops the question when the write finishes first", async () => {
    const { controller, state, ready, idle, fake, dialogs } = setup({
      files: { "/image.bin": ramp(16) },
      socket: socketWith("EEPROM16", new Uint8Array(16)),
    });
    dialogs.open.mockResolvedValue("/image.bin");
    await controller.openFile();
    await ready("EEPROM16");
    fake.hold();
    controller.run("write");
    controller.confirm();
    controller.requestCancel();
    fake.release();
    await idle();
    expect(state().confirm).toBeNull();
    expect(state().outcome?.title).toBe("Wrote EEPROM16");
    // A late "stop" has nothing to stop.
    controller.confirm();
    expect(state().outcome?.title).toBe("Wrote EEPROM16");
  });
});

describe("differences", () => {
  it("opens the diff against the buffer when a verify fails", async () => {
    const onChip = ramp(16);
    onChip[5] = 0xee;
    const { controller, state, ready, idle, dialogs, commands } = setup({
      files: { "/image.bin": ramp(16) },
      socket: socketWith("EEPROM16", onChip),
    });
    dialogs.open.mockResolvedValue("/image.bin");
    await controller.openFile();
    await ready("EEPROM16");
    const phases = new Set<string>();
    controller.subscribe(() => {
      const running = state().running;
      if (running) phases.add(running.phase);
    });
    controller.run("verify");
    await idle();
    expect([...phases]).toEqual(["main", "readback"]);
    expect(state().outcome).toMatchObject({ tone: "error", title: "Verify failed" });
    expect(state().outcome?.details).toEqual([
      "Verification failed at address 0x0005: File=0x05, Device=0xEE.",
      "EEPROM16 doesn't match the buffer.",
      "The differences are shown under the buffer.",
    ]);
    expect(state().diff).toEqual({ chip: "EEPROM16", read: onChip, after: "verify" });
    expect(commands().slice(-2)).toEqual(["verify", "read"]);

    controller.closeDiff();
    expect(state().diff).toBeNull();
  });

  it("opens the diff when a write doesn't take", async () => {
    const { controller, state, ready, idle, dialogs, fake } = setup({
      files: { "/image.bin": ramp(16, 1) },
      socket: {
        chip: "EEPROM16",
        memory: new Uint8Array(16).fill(0xff),
        writeProtected: true,
      },
    });
    dialogs.open.mockResolvedValue("/image.bin");
    await controller.openFile();
    await ready("EEPROM16");
    controller.run("write");
    controller.confirm();
    await idle();
    expect(state().outcome).toMatchObject({
      tone: "error",
      title: "Write failed verification",
    });
    expect(state().diff).toMatchObject({ chip: "EEPROM16", after: "write" });
    expect(state().diff?.read).toEqual(new Uint8Array(16).fill(0xff));
    expect(last(fake.calls)?.command).toBe("read");
  });

  it("says so when the read-back is cancelled or fails", async () => {
    const onChip = ramp(16);
    onChip[0] = 0xee;
    const { controller, state, ready, idle, dialogs, fake } = setup({
      files: { "/image.bin": ramp(16) },
      socket: socketWith("EEPROM16", onChip),
    });
    dialogs.open.mockResolvedValue("/image.bin");
    await controller.openFile();
    await ready("EEPROM16");

    // Stop the fake as the read-back starts, so the cancel lands inside it.
    const unsubscribe = controller.subscribe(() => {
      if (state().running?.phase === "readback") fake.hold();
    });
    controller.run("verify");
    await soon(() => expect(state().running?.phase).toBe("readback"));
    unsubscribe();
    controller.requestCancel();
    // A read-back is a read: no question asked.
    expect(state().confirm).toBeNull();
    fake.release();
    await idle();
    expect(state().diff).toBeNull();
    expect(state().outcome?.title).toBe("Verify failed");
    expect(last(state().outcome?.details ?? [])).toBe(
      "The read-back was cancelled, so the differences aren't shown.",
    );

    const read = fake.read;
    fake.read = () =>
      Promise.reject({ kind: "minipro", message: "minipro error: IO error", device_state: null });
    controller.run("verify");
    await idle();
    expect(last(state().outcome?.details ?? [])).toBe(
      "burnwright couldn't read the chip back to show the differences: IO error",
    );
    fake.read = read;
  });

  it("closes the diff when another operation starts or the chip changes", async () => {
    const onChip = ramp(16);
    onChip[5] = 0xee;
    const { controller, state, ready, idle, dialogs } = setup({
      files: { "/image.bin": ramp(16) },
      socket: socketWith("EEPROM16", onChip),
    });
    dialogs.open.mockResolvedValue("/image.bin");
    await controller.openFile();
    await ready("EEPROM16");
    controller.run("verify");
    await idle();
    expect(state().diff).not.toBeNull();
    controller.run("blank_check");
    expect(state().diff).toBeNull();
    await idle();

    controller.run("verify");
    await idle();
    expect(state().diff).not.toBeNull();
    controller.selectChip({ name: "FLASH32@SOIC8", package: "SOIC8" });
    expect(state().diff).toBeNull();
    expect(state().outcome).toBeNull();
  });
});

describe("reading over edits", () => {
  it("asks before a read replaces unsaved edits", async () => {
    const { controller, state, ready, idle, fake } = setup({
      socket: socketWith("EEPROM16", ramp(16)),
    });
    await ready("EEPROM16");
    controller.run("read");
    await idle();
    const edited = ramp(16);
    edited[0] = 0x99;
    controller.editBuffer(edited, true);

    controller.run("read");
    expect(state().confirm).toMatchObject({ kind: "replace_buffer", by: "read" });
    expect(state().running).toBeNull();
    controller.dismissConfirm();
    expect(state().buffer?.bytes).toEqual(edited);
    expect(fake.calls.filter((c) => c.command === "read")).toHaveLength(1);

    controller.run("read");
    controller.confirm();
    await idle();
    expect(state().buffer?.bytes).toEqual(ramp(16));
    expect(unsavedBuffer(state().buffer)).toBe("read");
  });
});

describe("files and operations keep out of each other's way", () => {
  /** A promise the test settles by hand. */
  function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("starts no operation while a file is being picked or loaded", async () => {
    const { controller, state, ready, idle, fake, dialogs } = setup({
      files: { "/full.bin": ramp(16), "/short.bin": ramp(10, 0x80) },
      socket: socketWith("EEPROM16", ramp(16)),
    });
    dialogs.open.mockResolvedValue("/full.bin");
    await controller.openFile();
    await ready("EEPROM16");

    // The panel is up, and then the load is on its way.
    const picked = deferred<string | null>();
    dialogs.open.mockReturnValue(picked.promise);
    const opening = controller.openFile();
    expect(state().fileBusy).toBe("opening");
    for (const op of ["read", "verify", "blank_check", "erase", "write", "check"] as const) {
      expect(operationAvailability(state(), op)).toEqual({
        enabled: false,
        reason: "A file is being opened.",
      });
      controller.run(op);
    }
    expect(state().confirm).toBeNull();
    expect(state().running).toBeNull();
    // A second Open doesn't stack up behind the first.
    await controller.openFile();
    expect(dialogs.open).toHaveBeenCalledTimes(2);

    picked.resolve("/short.bin");
    await opening;
    expect(state().fileBusy).toBeNull();
    expect(state().buffer?.bytes).toEqual(ramp(10, 0x80));

    // Now the write is asked about the buffer that will be written.
    controller.run("write");
    expect(bufferSizeCheck(state())).toEqual({ status: "short", buffer: 10, chip: 16 });
    controller.dismissConfirm();
    expect(fake.calls.some((c) => c.command === "write")).toBe(false);
    await idle();
  });

  it("frees the screen again when the open panel is dismissed or the load fails", async () => {
    const { controller, state, dialogs } = setup();
    dialogs.open.mockResolvedValueOnce(null);
    await controller.openFile();
    expect(state().fileBusy).toBeNull();
    dialogs.open.mockResolvedValueOnce("/nope.bin");
    await controller.openFile();
    expect(state().fileBusy).toBeNull();
    expect(state().fileError).toContain("Couldn't open nope.bin");
    dialogs.open.mockRejectedValueOnce(new Error("no window"));
    await controller.openFile();
    expect(state().fileBusy).toBeNull();
    expect(state().fileError).toBe("Couldn't show the open dialog: no window");
  });

  it("doesn't open or save a file under a running operation", async () => {
    const { controller, state, ready, idle, fake, dialogs } = setup({
      files: { "/a.bin": ramp(16, 3) },
      socket: socketWith("EEPROM16", ramp(16)),
    });
    dialogs.open.mockResolvedValue("/a.bin");
    await controller.openFile();
    await ready("EEPROM16");
    dialogs.open.mockClear();
    fake.hold();
    controller.run("read");
    await controller.openFile();
    await controller.save();
    await controller.saveAs();
    expect(dialogs.open).not.toHaveBeenCalled();
    expect(dialogs.save).not.toHaveBeenCalled();
    expect(fake.saved).toEqual({});
    fake.release();
    await idle();
    // The read is what it says it is: from the chip, with no file's name on it.
    expect(state().buffer?.source).toEqual({ kind: "chip", chip: "EEPROM16" });
    expect(state().buffer?.path).toBeNull();
  });

  it("starts no operation while the buffer is being saved, and saves the bytes as they are then", async () => {
    const { controller, state, ready, fake, dialogs } = setup({
      files: { "/a.bin": ramp(16) },
      socket: socketWith("EEPROM16", ramp(16, 0x40)),
    });
    dialogs.open.mockResolvedValue("/a.bin");
    await controller.openFile();
    await ready("EEPROM16");
    const where = deferred<string | null>();
    dialogs.save.mockReturnValue(where.promise);
    const saving = controller.saveAs();
    expect(state().fileBusy).toBe("saving");
    expect(operationAvailability(state(), "read").reason).toBe("The buffer is being saved.");
    controller.run("read");
    expect(state().running).toBeNull();
    // An edit made while the panel is up goes into the file.
    const edited = ramp(16);
    edited[0] = 0x77;
    controller.editBuffer(edited, true);
    where.resolve("/b.bin");
    await saving;
    expect(fake.saved["/b.bin"]).toEqual(edited);
    expect(state().fileBusy).toBeNull();
    expect(unsavedBuffer(state().buffer)).toBeNull();
    expect(fake.calls.some((c) => c.command === "read")).toBe(false);
  });

  it("drops the last outcome, and its override, when the buffer changes", async () => {
    const { controller, state, ready, idle, fake, dialogs } = setup({
      files: { "/a.bin": ramp(16), "/short.bin": ramp(10) },
      socket: socketWith("EEPROM16", ramp(16)),
    });
    dialogs.open.mockResolvedValue("/a.bin");
    await controller.openFile();
    await ready("EEPROM16");
    fake.failNext({
      kind: "size_mismatch",
      message: "the image is 16 bytes and the chip takes 32",
      device_state: null,
    });
    controller.run("verify");
    await idle();
    expect(state().outcome?.retry).not.toBeNull();

    // Another file: the offer to ignore the size was about the old one.
    dialogs.open.mockResolvedValue("/short.bin");
    await controller.openFile();
    expect(state().outcome).toBeNull();
    controller.retry();
    expect(state().running).toBeNull();
    expect(fake.calls.filter((c) => c.command === "verify")).toHaveLength(1);
    // Verifying the new buffer asks about its own mismatch.
    controller.run("verify");
    expect(state().confirm).toMatchObject({ kind: "verify_size" });
    controller.dismissConfirm();

    // An edit clears a "passed" that no longer describes the buffer.
    dialogs.open.mockResolvedValue("/a.bin");
    await controller.openFile();
    controller.run("verify");
    await idle();
    expect(state().outcome?.title).toBe("Verify passed");
    // The editor handing back the bytes it was given isn't an edit.
    controller.editBuffer(state().buffer!.bytes, false);
    expect(state().outcome?.title).toBe("Verify passed");
    const edited = ramp(16);
    edited[1] = 0x55;
    controller.editBuffer(edited, true);
    expect(state().outcome).toBeNull();
  });
});

describe("a chip read that isn't in a file", () => {
  const context = { size: { status: "none" } as const, bufferLength: 16, availability: null };

  it("asks before another read replaces it, edited or not", async () => {
    const { controller, state, ready, idle, fake } = setup({
      socket: socketWith("EEPROM16", ramp(16)),
    });
    await ready("EEPROM16");
    controller.run("read");
    await idle();
    expect(unsavedBuffer(state().buffer)).toBe("read");

    controller.run("read");
    expect(state().running).toBeNull();
    expect(state().confirm).toEqual({
      kind: "replace_buffer",
      by: "read",
      unsaved: "read",
      overrides: { ignoreChipId: false, ignoreSize: false },
    });
    expect(confirmCopy(state().confirm!, context).paragraphs).toEqual([
      "The buffer holds a chip read that hasn't been saved to a file. Reading the chip replaces it.",
    ]);
    controller.dismissConfirm();
    expect(fake.calls.filter((c) => c.command === "read")).toHaveLength(1);

    // Edits on top of it don't make it any more saved.
    const edited = ramp(16);
    edited[3] = 0x11;
    controller.editBuffer(edited, true);
    expect(unsavedBuffer(state().buffer)).toBe("read");
    controller.run("read");
    controller.confirm();
    await idle();
    expect(fake.calls.filter((c) => c.command === "read")).toHaveLength(2);
    expect(state().buffer?.bytes).toEqual(ramp(16));
  });

  it("asks before a file replaces it", async () => {
    const { controller, state, ready, idle, dialogs } = setup({
      files: { "/a.bin": ramp(4) },
      socket: socketWith("EEPROM16", ramp(16)),
    });
    await ready("EEPROM16");
    controller.run("read");
    await idle();
    dialogs.open.mockResolvedValue("/a.bin");

    await controller.openFile();
    expect(dialogs.open).not.toHaveBeenCalled();
    expect(state().confirm).toMatchObject({ kind: "replace_buffer", by: "file", unsaved: "read" });
    expect(confirmCopy(state().confirm!, context).paragraphs).toEqual([
      "The buffer holds a chip read that hasn't been saved to a file. Opening a file replaces it.",
    ]);
    controller.dismissConfirm();
    expect(state().buffer?.bytes).toEqual(ramp(16));

    await controller.openFile();
    controller.confirm();
    await soon(() => expect(state().buffer?.bytes).toEqual(ramp(4)));
  });

  it("stops asking once the read is saved", async () => {
    const { controller, state, ready, idle, dialogs, fake } = setup({
      socket: socketWith("EEPROM16", ramp(16)),
    });
    await ready("EEPROM16");
    controller.run("read");
    await idle();
    dialogs.save.mockResolvedValue("/out/dump.bin");
    await controller.save();
    expect(unsavedBuffer(state().buffer)).toBeNull();

    controller.run("read");
    expect(state().confirm).toBeNull();
    await idle();
    expect(fake.calls.filter((c) => c.command === "read")).toHaveLength(2);
    // The new read is a new buffer, and isn't in dump.bin.
    expect(state().buffer?.path).toBeNull();
    expect(unsavedBuffer(state().buffer)).toBe("read");
  });
});

describe("closing the window", () => {
  const context = { size: { status: "none" } as const, bufferLength: 16, availability: null };

  /** A write of a saved file to EEPROM16, held before it finishes. */
  async function heldWrite() {
    const made = setup({
      files: { "/image.bin": ramp(16, 0x20) },
      socket: socketWith("EEPROM16", new Uint8Array(16)),
    });
    made.dialogs.open.mockResolvedValue("/image.bin");
    await made.controller.openFile();
    await made.ready("EEPROM16");
    made.fake.hold();
    made.controller.run("write");
    made.controller.confirm();
    expect(made.state().running?.op).toBe("write");
    return made;
  }

  it("closes at once when there is nothing to lose", async () => {
    const { controller, state, dialogs, closeWindow } = setup({
      files: { "/a.bin": ramp(4) },
    });
    expect(controller.requestClose()).toBe(true);
    dialogs.open.mockResolvedValue("/a.bin");
    await controller.openFile();
    expect(controller.requestClose()).toBe(true);
    expect(state().confirm).toBeNull();
    // The window closes itself when it's told it may.
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it("asks before closing over a chip read that isn't saved", async () => {
    const { controller, state, ready, idle, closeWindow } = setup({
      socket: socketWith("EEPROM16", ramp(16)),
    });
    await ready("EEPROM16");
    controller.run("read");
    await idle();

    expect(controller.requestClose()).toBe(false);
    expect(state().confirm).toEqual({ kind: "close", stop: null, unsaved: "read" });
    expect(confirmCopy(state().confirm!, context)).toEqual({
      title: "Close without saving?",
      paragraphs: [
        "The buffer holds a chip read that hasn't been saved to a file. Closing loses it.",
      ],
      confirm: "Close without saving",
      cancel: "Keep burnwright open",
    });
    controller.dismissConfirm();
    expect(closeWindow).not.toHaveBeenCalled();

    expect(controller.requestClose()).toBe(false);
    controller.confirm();
    expect(state().confirm).toBeNull();
    expect(closeWindow).toHaveBeenCalledTimes(1);
  });

  it("asks before closing over edits that aren't saved", async () => {
    const { controller, state, dialogs, closeWindow } = setup({ files: { "/a.bin": ramp(4) } });
    dialogs.open.mockResolvedValue("/a.bin");
    await controller.openFile();
    controller.editBuffer(bytes(9, 1, 2, 3), true);

    expect(controller.requestClose()).toBe(false);
    expect(state().confirm).toEqual({ kind: "close", stop: null, unsaved: "edits" });
    expect(confirmCopy(state().confirm!, context).paragraphs).toEqual([
      "The buffer has edits that haven't been saved to a file. Closing loses them.",
    ]);
    controller.dismissConfirm();
    await controller.save();
    expect(controller.requestClose()).toBe(true);
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it("asks before stopping a write, stops it, and only then closes", async () => {
    const { controller, state, fake, closeWindow } = await heldWrite();

    expect(controller.requestClose()).toBe(false);
    expect(state().confirm).toEqual({
      kind: "close",
      stop: { op: "write", chip: "EEPROM16" },
      unsaved: null,
    });
    expect(confirmCopy(state().confirm!, context)).toEqual({
      title: "Stop the write and close?",
      paragraphs: [
        "A write to EEPROM16 is running. Closing stops it and leaves EEPROM16 half-programmed: it will need erasing or writing again before it's any use.",
      ],
      confirm: "Stop the write and close",
      cancel: "Keep writing",
    });
    // "Keep writing": the write goes on and the window stays.
    controller.dismissConfirm();
    expect(state().running?.cancelling).toBe(false);

    expect(controller.requestClose()).toBe(false);
    controller.confirm();
    expect(state().confirm).toBeNull();
    expect(state().running?.cancelling).toBe(true);
    // Not before minipro has stopped.
    expect(closeWindow).not.toHaveBeenCalled();
    fake.release();
    await soon(() => expect(closeWindow).toHaveBeenCalledTimes(1));
    expect(state().running).toBeNull();
    expect(state().outcome?.title).toBe("Write cancelled");
  });

  it("names an erase, and the unsaved buffer with it", async () => {
    const { controller, state, ready, idle, fake } = setup({
      socket: socketWith("EEPROM16", ramp(16)),
    });
    await ready("EEPROM16");
    controller.run("read");
    await idle();
    fake.hold();
    controller.run("erase");
    controller.confirm();

    expect(controller.requestClose()).toBe(false);
    expect(confirmCopy(state().confirm!, context)).toEqual({
      title: "Stop the erase and close?",
      paragraphs: [
        "An erase of EEPROM16 is running. Closing stops it and leaves EEPROM16 half-erased: it will need erasing again before it's any use.",
        "The buffer holds a chip read that hasn't been saved to a file. Closing loses it.",
      ],
      confirm: "Stop the erase and close",
      cancel: "Keep erasing",
    });
    controller.dismissConfirm();
    fake.release();
    await idle();
  });

  it("stops a read without asking, then closes", async () => {
    const { controller, state, ready, fake, closeWindow } = setup({
      socket: socketWith("EEPROM16", ramp(16)),
    });
    await ready("EEPROM16");
    fake.hold();
    controller.run("read");

    expect(controller.requestClose()).toBe(false);
    expect(state().confirm).toBeNull();
    expect(state().running?.cancelling).toBe(true);
    expect(closeWindow).not.toHaveBeenCalled();
    fake.release();
    await soon(() => expect(closeWindow).toHaveBeenCalledTimes(1));
  });

  it("lets a second close through when the operation won't stop", async () => {
    const { controller, fake, closeWindow } = await heldWrite();
    expect(controller.requestClose()).toBe(false);
    controller.confirm();
    // Still held: minipro hasn't stopped. The user must be able to leave.
    expect(controller.requestClose()).toBe(true);
    expect(closeWindow).not.toHaveBeenCalled();
    fake.release();
  });

  it("drops the question when the write finishes while it's up", async () => {
    const { controller, state, idle, fake, closeWindow } = await heldWrite();
    expect(controller.requestClose()).toBe(false);
    expect(state().confirm?.kind).toBe("close");
    fake.release();
    await idle();
    expect(state().outcome?.title).toBe("Wrote EEPROM16");
    // The write is done and the buffer is in its file: nothing left to ask.
    expect(state().confirm).toBeNull();
    expect(closeWindow).not.toHaveBeenCalled();
    expect(controller.requestClose()).toBe(true);
  });

  it("asks only about the buffer once a write it would have stopped is over", async () => {
    const { controller, state, ready, idle, fake } = setup({
      socket: socketWith("EEPROM16", ramp(16)),
    });
    await ready("EEPROM16");
    controller.run("read");
    await idle();
    fake.hold();
    controller.run("write");
    controller.confirm();
    expect(controller.requestClose()).toBe(false);
    expect(state().confirm).toMatchObject({ kind: "close", stop: { op: "write" } });
    fake.release();
    await idle();
    expect(state().confirm).toEqual({ kind: "close", stop: null, unsaved: "read" });
  });
});
