import { describe, expect, it } from "vitest";
import { CH341A, KB9012, type EngineError, type SessionInfo } from "../engine";
import {
  failureOutcome,
  flashromReady,
  initialState,
  progressLabel,
  reducer,
  stepAvailability,
  WIRING,
  wiringDone,
  type Action,
  type EcState,
} from "./state";

const READY = {
  availability: { status: "ready", version: "v1.8.0" },
  path: "/opt/homebrew/sbin/flashrom",
  source: "system",
} as const;

const SESSION: SessionInfo = {
  id: 3,
  backend: "flashrom",
  probe: CH341A,
  chip: {
    target: KB9012,
    size: 131072,
    fingerprint: "hwversion 0xc3, ediid 0x04",
    detail: "ENE KB9012 (EDI) on a CH341A",
  },
  capabilities: {
    ops: { read: true, write: false, verify: true, erase: false, blank_check: true },
    regions: ["code"],
    auto_identify: false,
    write_verifies: true,
    erased: 0,
    in_circuit: true,
    cancel: "until_mutating",
    typical_write_secs: 1800,
  },
  backup_required: true,
};

const BACKUP = { path: "/b/ene.bin", sha256: "ab".repeat(32), len: 131072, region: "code" } as const;

const apply = (state: EcState, ...actions: Action[]) => actions.reduce(reducer, state);
const tickAll = (state: EcState) =>
  apply(state, ...WIRING.map((c): Action => ({ type: "wiring", id: c.id, checked: true })));
const error = (kind: EngineError["kind"], message = "x"): EngineError => ({
  kind,
  message,
  device_state: null,
});

describe("what can start", () => {
  it("is nothing until flashrom has been found", () => {
    const state = initialState();
    expect(flashromReady(state)).toBe(false);
    expect(stepAvailability(state, "probe")).toEqual({
      enabled: false,
      reason: "Looking for flashrom.",
    });
    const missing = apply(state, {
      type: "flashrom",
      status: {
        availability: { status: "missing", reason: "flashrom not found" },
        path: null,
        source: null,
      },
    });
    expect(stepAvailability(missing, "identify").reason).toBe("flashrom isn't installed.");
  });

  it("lets the search run before the wiring is checked, and nothing else", () => {
    const state = apply(initialState(), { type: "flashrom", status: READY });
    expect(stepAvailability(state, "probe").enabled).toBe(true);
    expect(stepAvailability(state, "identify")).toEqual({
      enabled: false,
      reason: "Tick every wiring check first.",
    });
    // All but one isn't all.
    const most = apply(
      state,
      ...WIRING.slice(1).map((c): Action => ({ type: "wiring", id: c.id, checked: true })),
    );
    expect(wiringDone(most)).toBe(false);
    expect(stepAvailability(most, "identify").enabled).toBe(false);
  });

  it("wants the chip identified before a backup", () => {
    const wired = tickAll(apply(initialState(), { type: "flashrom", status: READY }));
    expect(stepAvailability(wired, "identify").enabled).toBe(true);
    expect(stepAvailability(wired, "backup").reason).toBe("Identify the chip first.");
    const open = apply(wired, { type: "identified", session: SESSION });
    expect(stepAvailability(open, "backup").enabled).toBe(true);
  });

  it("runs one step at a time", () => {
    const running = apply(
      tickAll(apply(initialState(), { type: "flashrom", status: READY })),
      { type: "identified", session: SESSION },
      { type: "started", step: "backup" },
    );
    for (const step of ["probe", "identify", "backup"] as const) {
      expect(stepAvailability(running, step)).toEqual({
        enabled: false,
        reason: "A backup is running.",
      });
    }
  });
});

describe("the session", () => {
  const open = apply(
    tickAll(apply(initialState(), { type: "flashrom", status: READY })),
    { type: "identified", session: SESSION },
    { type: "backed_up", backup: BACKUP },
  );

  it("is dropped, with its backup, when a wiring check is unticked", () => {
    expect(open.session).toEqual(SESSION);
    expect(open.backup).toEqual(BACKUP);
    const changed = apply(open, { type: "wiring", id: "ground", checked: false });
    expect(changed.session).toBeNull();
    expect(changed.backup).toBeNull();
    expect(changed.outcome).toBeNull();
    expect(stepAvailability(changed, "backup").enabled).toBe(false);
  });

  it("survives a backup that fails, but not a programmer that's gone", () => {
    const flaky = apply(open, {
      type: "failed",
      step: "backup",
      error: error("inconsistent_reads"),
    });
    expect(flaky.session).toEqual(SESSION);
    const unplugged = apply(open, {
      type: "failed",
      step: "backup",
      error: error("no_programmer"),
    });
    expect(unplugged.session).toBeNull();
    expect(unplugged.probe).toEqual({ status: "none" });
  });

  it("is closed by an identify that fails", () => {
    const failed = apply(open, { type: "failed", step: "identify", error: error("no_chip") });
    expect(failed.session).toBeNull();
  });

  it("means the programmer is there", () => {
    const state = apply(
      tickAll(apply(initialState(), { type: "flashrom", status: READY })),
      { type: "probed", probes: [] },
    );
    expect(state.probe).toEqual({ status: "none" });
    const found = apply(state, { type: "identified", session: SESSION });
    expect(found.probe.status).toBe("found");
  });
});

describe("flashrom", () => {
  it("forgets what it knew about the programmer when it changes", () => {
    const state = apply(
      initialState(),
      { type: "flashrom", status: READY },
      {
        type: "probed",
        probes: [{ backend: "flashrom", probe: CH341A, model: "CH341A", firmware: null }],
      },
    );
    expect(state.probe.status).toBe("found");
    const same = apply(state, { type: "flashrom", status: READY });
    expect(same.probe.status).toBe("found");
    const other = apply(state, {
      type: "flashrom",
      status: { ...READY, path: "/opt/flashrom", source: "configured" },
      chosen: "/opt/flashrom",
    });
    expect(other.probe).toEqual({ status: "unknown" });
    expect(other.flashromChosen).toBe("/opt/flashrom");
    // A status check that doesn't say what was chosen leaves it alone.
    expect(apply(other, { type: "flashrom", status: READY }).flashromChosen).toBe(
      "/opt/flashrom",
    );
    expect(
      apply(other, { type: "flashrom", status: READY, chosen: null }).flashromChosen,
    ).toBeNull();
  });
});

describe("progress", () => {
  const running = apply(
    tickAll(apply(initialState(), { type: "flashrom", status: READY })),
    { type: "identified", session: SESSION },
    { type: "started", step: "backup" },
  );

  it("counts the reads of a backup", () => {
    expect(progressLabel(running.running!, SESSION)).toBe("Reading the chip (1 of 2)");
    const first = apply(running, {
      type: "progress",
      event: { type: "stage_started", stage: "read", label: "Reading flash" },
    });
    expect(first.running).toMatchObject({ stage: "Reading flash", pass: 1, percent: null });
    expect(progressLabel(first.running!, SESSION)).toBe("Reading the chip (1 of 2)");
    const second = apply(
      first,
      { type: "progress", event: { type: "progress", stage: "read", percent: 50 } },
      { type: "progress", event: { type: "stage_finished", stage: "read", seconds: null } },
      { type: "progress", event: { type: "stage_started", stage: "read", label: "Reading flash" } },
    );
    expect(second.running).toMatchObject({ pass: 2, percent: null });
    expect(progressLabel(second.running!, SESSION)).toBe(
      "Reading the chip again to check the first read (2 of 2)",
    );
  });

  it("says one read for a chip that isn't on a live board", () => {
    const socketed = {
      ...SESSION,
      capabilities: { ...SESSION.capabilities, in_circuit: false },
    };
    expect(progressLabel(running.running!, socketed)).toBe("Reading the chip");
  });

  it("logs commands and output, and the step as a heading", () => {
    const state = apply(
      running,
      { type: "progress", event: { type: "command", line: "flashrom -p ch341a_spi" } },
      { type: "progress", event: { type: "warning", message: "careful" } },
    );
    expect(state.log.map((l) => [l.kind, l.text])).toEqual([
      ["heading", "Back up"],
      ["command", "flashrom -p ch341a_spi"],
      ["warning", "careful"],
    ]);
    expect(apply(state, { type: "clear_log" }).log).toEqual([]);
  });

  it("says it's stopping once a cancel is sent", () => {
    const stopping = apply(running, { type: "cancelling" });
    expect(stopping.running?.cancelling).toBe(true);
    expect(progressLabel(stopping.running!, SESSION)).toBe(
      "Stopping, then letting the EC run again",
    );
  });
});

describe("outcomes", () => {
  it("say what answered, and what was saved", () => {
    const open = apply(
      tickAll(apply(initialState(), { type: "flashrom", status: READY })),
      { type: "identified", session: SESSION },
    );
    expect(open.outcome).toMatchObject({ tone: "ok", title: "KB9012 (EDI) answered" });
    expect(open.outcome?.details).toContain("128 KiB of flash. ID: hwversion 0xc3, ediid 0x04.");
    const saved = apply(open, { type: "backed_up", backup: BACKUP });
    expect(saved.outcome).toMatchObject({ tone: "ok", title: "Backup saved" });
    expect(saved.outcome?.details[0]).toBe("The chip was read twice and both reads match.");
  });

  it("word each failure with what to try", () => {
    expect(failureOutcome("backup", error("cancelled"))).toMatchObject({
      tone: "warning",
      title: "Backup cancelled",
    });
    expect(failureOutcome("identify", error("no_programmer")).title).toBe("No CH341A found");
    const silent = failureOutcome("identify", error("no_chip", "nothing answered as a KB9012"));
    expect(silent.title).toBe("Nothing answered");
    expect(silent.details[0]).toBe("nothing answered as a KB9012");
    expect(silent.details.join(" ")).toMatch(/pin 42/);
    expect(failureOutcome("identify", error("chip_id_mismatch")).title).toBe(
      "A different chip answered",
    );
    const flaky = failureOutcome("backup", error("inconsistent_reads"));
    expect(flaky.title).toBe("The two reads don't match");
    expect(flaky.details.join(" ")).toMatch(/Nothing was saved/);
    expect(failureOutcome("backup", error("busy")).title).toBe("The CH341A is busy");
    expect(failureOutcome("backup", error("flashrom", "flashrom error: boom"))).toMatchObject({
      tone: "error",
      title: "Backup failed",
      details: ["flashrom error: boom"],
    });
    // Not an EngineError at all.
    expect(failureOutcome("probe", new Error("ipc down"))).toMatchObject({
      title: "Search failed",
      details: ["ipc down"],
    });
  });
});
