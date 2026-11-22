import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { createFakeBench, type FakeBenchOptions } from "../../dev/fakeBench";
import { EcController, type EcDeps } from "../../lib/ec/controller";
import { WIRING } from "../../lib/ec/state";
import { EcScreen } from "./EcScreen";

function setup(options: FakeBenchOptions = {}, deps: Partial<EcDeps> = {}) {
  const bench = createFakeBench(options);
  const controller = new EcController({ bench, ...deps });
  render(<EcScreen controller={controller} footer="burnwright test" />);
  return { bench, controller };
}

const button = (name: string | RegExp) => screen.getByRole("button", { name });
const region = (name: string) => screen.getByRole("region", { name });
const checks = () => within(region("Wiring")).getAllByRole("checkbox");
const tickAll = () => checks().forEach((box) => fireEvent.click(box));
const outcome = (title: string) =>
  screen.findByRole("heading", { name: title }).then((h) => h.closest("article") as HTMLElement);

/** Wait for the first look at flashrom and the CH341A to finish. */
async function ready() {
  await within(region("Programmer")).findByText("CH341A connected");
}

describe("when the screen opens", () => {
  it("shows flashrom and the programmer, and holds the steps for the wiring", async () => {
    setup();
    await ready();
    expect(within(region("flashrom")).getByText("flashrom v1.8.0")).toBeInTheDocument();
    expect(within(region("flashrom")).getByText("/opt/homebrew/sbin/flashrom")).toBeInTheDocument();
    expect(checks()).toHaveLength(WIRING.length);
    expect(button("Identify")).toBeDisabled();
    expect(button("Back up")).toBeDisabled();
    expect(button("Identify")).toHaveAccessibleDescription("Tick every wiring check first.");
    expect(screen.getByText("burnwright test")).toBeInTheDocument();
  });

  it("says how to get flashrom when there isn't one", async () => {
    const chooseFlashrom = vi.fn<() => Promise<string | null>>().mockResolvedValue("/opt/flashrom");
    setup({ flashrom: null, otherFlashroms: ["/opt/flashrom"] }, { chooseFlashrom });
    const panel = region("flashrom");
    await within(panel).findByText("Not found");
    expect(within(panel).getByText(/brew install flashrom/)).toBeInTheDocument();
    expect(button("Look for it")).toBeDisabled();

    fireEvent.click(within(panel).getByRole("button", { name: "Choose flashrom…" }));
    await within(panel).findByText("/opt/flashrom (chosen here)");
    await ready();
    expect(within(panel).getByRole("button", { name: "Use the one installed" })).toBeEnabled();
  });

  it("says when no CH341A is plugged in, and looks again on request", async () => {
    const { bench } = setup({ programmer: false });
    const panel = region("Programmer");
    await within(panel).findByText("No CH341A found");
    const why = await within(panel).findByRole("region", { name: "Why no CH341A was found" });
    expect(within(why).getByRole("heading", { name: "No CH341A plugged in" })).toBeInTheDocument();
    expect(within(why).getByText(/mode jumper/)).toBeInTheDocument();

    bench.setProgrammer(true);
    fireEvent.click(within(panel).getByRole("button", { name: "Look again" }));
    await within(panel).findByText("CH341A connected");
    expect(within(panel).queryByRole("region", { name: "Why no CH341A was found" })).toBeNull();
  });

  it("tells a Linux user their CH341A is there and needs a udev rule", async () => {
    setup({ access: "no_udev_rule" });
    const panel = region("Programmer");
    // flashrom's "couldn't open" isn't passed on as "not found" once the OS
    // has said the programmer is there.
    await within(panel).findByText("CH341A plugged in, but not usable yet");
    expect(within(panel).queryByText("No CH341A found")).toBeNull();
    const why = await within(panel).findByRole("region", { name: "Why no CH341A was found" });
    expect(
      within(why).getByRole("heading", { name: "No permission to use the programmer" }),
    ).toBeInTheDocument();
    expect(within(why).getByText("CH341A (1a86:5512)")).toBeInTheDocument();
    expect(within(why).getByText(/60-burnwright-flashrom\.rules/)).toBeInTheDocument();
    expect(within(why).getByRole("button", { name: "Copy command" })).toBeInTheDocument();
  });
});

describe("a backup", () => {
  it("goes: tick the wiring, identify, back up, and shows where the file is", async () => {
    const reveal = vi.fn<(path: string) => Promise<void>>().mockResolvedValue();
    const { controller } = setup({}, { reveal });
    await ready();
    tickAll();
    expect(button("Identify")).toBeEnabled();
    expect(button("Back up")).toHaveAccessibleDescription("Identify the chip first.");

    fireEvent.click(button("Identify"));
    const found = await outcome("KB9012 (EDI) answered");
    expect(within(found).getByText(/128 KiB of flash/)).toBeInTheDocument();

    fireEvent.click(button("Back up"));
    const saved = await outcome("Backup saved");
    expect(within(saved).getByText(/read twice and both reads match/)).toBeInTheDocument();
    const backup = controller.getState().backup!;
    const steps = region("Backup");
    expect(within(steps).getByText(backup.path)).toBeInTheDocument();
    expect(within(steps).getByText(backup.sha256)).toBeInTheDocument();
    expect(within(steps).getByText("131,072 bytes")).toBeInTheDocument();
    expect(within(steps).queryByRole("heading", { name: "Last backup" })).toBeNull();

    fireEvent.click(within(steps).getByRole("button", { name: "Show in folder" }));
    await waitFor(() => expect(reveal).toHaveBeenCalledWith(backup.path));

    // The flashrom commands are in the log, under its own name.
    const log = screen.getByRole("log", { name: "flashrom commands and output" });
    expect(within(log).getAllByText(/-p ch341a_spi/).length).toBeGreaterThan(1);
  });

  it("shows progress with a Cancel that stops it", async () => {
    setup({ stepMs: 2, steps: 40 });
    await ready();
    tickAll();
    fireEvent.click(button("Identify"));
    await outcome("KB9012 (EDI) answered");
    fireEvent.click(button("Back up"));
    await screen.findByText("Reading the chip (1 of 2)");
    expect(screen.getByRole("progressbar", { name: "Back up progress" })).toBeInTheDocument();
    // The wiring can't be changed under a running read.
    for (const box of checks()) expect(box).toBeDisabled();
    fireEvent.click(button("Cancel"));
    const cancelled = await outcome("Backup cancelled");
    expect(within(cancelled).getByText("Nothing was saved.")).toBeInTheDocument();
    expect(screen.queryByText(/SHA-256/)).toBeNull();
  });

  it("keeps the earlier file on screen, as the last backup, when a later one fails", async () => {
    const { bench } = setup();
    await ready();
    tickAll();
    fireEvent.click(button("Identify"));
    await outcome("KB9012 (EDI) answered");
    fireEvent.click(button("Back up"));
    await outcome("Backup saved");
    bench.setProgrammer(false);
    fireEvent.click(button("Identify"));
    await outcome("No CH341A found");
    expect(
      within(region("Backup")).getByRole("heading", { name: "Last backup" }),
    ).toBeInTheDocument();
  });

  it("reports a chip that doesn't answer as an alert, with what to try", async () => {
    setup({ chip: "silent" });
    await ready();
    tickAll();
    fireEvent.click(button("Identify"));
    const failed = await outcome("Nothing answered");
    expect(failed).toHaveAttribute("role", "alert");
    expect(within(failed).getByText(/pin 42/)).toBeInTheDocument();
    expect(button("Back up")).toBeDisabled();
  });

  it("drops the identified chip when a wiring check is unticked", async () => {
    setup();
    await ready();
    tickAll();
    fireEvent.click(button("Identify"));
    await outcome("KB9012 (EDI) answered");
    expect(button("Back up")).toBeEnabled();
    fireEvent.click(checks()[2]);
    expect(button("Back up")).toBeDisabled();
    expect(screen.queryByRole("heading", { name: "KB9012 (EDI) answered" })).toBeNull();
  });
});

describe("with file paths hidden", () => {
  it("hides flashrom's path, the backup's and the ones in the log", async () => {
    const reveal = vi.fn<(path: string) => Promise<void>>().mockResolvedValue();
    const bench = createFakeBench();
    const controller = new EcController({ bench, reveal });
    const view = render(<EcScreen controller={controller} hidePaths />);
    await ready();
    tickAll();
    fireEvent.click(button("Identify"));
    await outcome("KB9012 (EDI) answered");
    fireEvent.click(button("Back up"));
    await outcome("Backup saved");

    const real = controller.getState();
    const backup = real.backup!;
    const flashrom = real.flashrom!.path!;
    const text = () => document.body.textContent ?? "";
    expect(text()).not.toContain(backup.path);
    expect(text()).not.toContain(flashrom);
    expect(text()).not.toContain("/tmp/");
    expect(text()).not.toMatch(/(^|[\s(])\/[A-Za-z]/);
    // The proof of the backup is still on screen, and the commands still read.
    const steps = region("Backup");
    expect(within(steps).getByText(backup.sha256)).toBeInTheDocument();
    expect(within(steps).getByText("131,072 bytes")).toBeInTheDocument();
    const log = screen.getByRole("log", { name: "flashrom commands and output" });
    expect(within(log).getAllByText(/-p ch341a_spi/).length).toBeGreaterThan(1);

    // The real file is the one that's shown in the folder.
    fireEvent.click(within(steps).getByRole("button", { name: "Show in folder" }));
    await waitFor(() => expect(reveal).toHaveBeenCalledWith(backup.path));

    view.rerender(<EcScreen controller={controller} />);
    expect(within(region("Backup")).getByText(backup.path)).toBeInTheDocument();
  });
});
