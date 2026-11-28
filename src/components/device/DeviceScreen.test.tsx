import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import {
  createFakeEngine,
  entropyOf,
  fakeChip,
  stringsOf,
  type FakeChip,
  type FakeEngineOptions,
} from "../../dev/fakeEngine";
import { DeviceController } from "../../lib/device/controller";
import { DeviceScreen } from "./DeviceScreen";

const CHIPS: FakeChip[] = [
  { info: fakeChip("EEPROM16", 16, { socket: { kind: "dip", pins: 8 } }) },
  { info: fakeChip("FLASH32@SOIC8", 32, { icsp: "ICP009.JPG" }), id: "0xEF4016" },
  { info: fakeChip("OTHER32@SOIC8", 32), id: "0xC22016" },
  { info: fakeChip("T56ONLY", 16, { available_on: ["t56"] }) },
  {
    info: fakeChip("NAND@SOP16", 0, {
      memory: { size: 0, unit: "bytes", bytes: null, data_sizes: [64] },
    }),
  },
  { info: fakeChip("AT28C256E", 16), unreadable: true },
  { info: { ...fakeChip("7400", 0), kind: "logic", available_on: [], memory: null } },
];

const ramp = (length: number, from = 0) =>
  Uint8Array.from({ length }, (_, i) => (from + i) & 0xff);

function setup(options: FakeEngineOptions = {}) {
  const fake = createFakeEngine({ chips: CHIPS, ...options });
  const dialogs = {
    open: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
    save: vi.fn<(suggested: string) => Promise<string | null>>().mockResolvedValue(null),
    openAlgorithms: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
  };
  const controller = new DeviceController({ engine: fake, dialogs });
  render(<DeviceScreen controller={controller} footer="burnwright test" />);
  return { fake, dialogs, controller };
}

const button = (name: string | RegExp) => screen.getByRole("button", { name });
const click = (name: string | RegExp) => fireEvent.click(button(name));
const search = () => screen.getByRole("combobox", { name: /chip list$/ });
const operations = () => screen.getByRole("region", { name: "Operations" });
/** The outcome of the last operation: an alert when it failed, a status otherwise. */
const outcome = (title: string) =>
  screen.findByRole("heading", { name: title }).then((h) => h.closest("article") as HTMLElement);

/** Detect, then pick `chip` from the search box with the keyboard. */
async function pick(chip: string) {
  click(/^Detect/);
  await screen.findByText(/firmware 01\.1\.32$/);
  fireEvent.change(search(), { target: { value: chip } });
  await screen.findByRole("option", { name: new RegExp(`^${chip.replace(/[()]/g, "\\$&")}`) });
  fireEvent.keyDown(search(), { key: "Enter" });
  await screen.findByRole("heading", { name: chip });
  await waitFor(() => expect(screen.queryByText("Loading details…")).toBeNull());
}

async function openFile(dialogs: ReturnType<typeof setup>["dialogs"], path: string) {
  dialogs.open.mockResolvedValue(path);
  click("Open…");
  await screen.findByRole("grid", { name: "Buffer bytes" });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("programmer bar", () => {
  it("shows the model, the firmware and minipro's warnings", async () => {
    setup({
      programmer: {
        programmer: "T48",
        firmware: "00.1.03",
        chip: null,
        firmware_status: "out_of_date",
        firmware_expected: "01.1.32",
        support_warning: "T48 support is not yet complete!",
      },
    });
    const bar = screen.getByRole("region", { name: "Programmer" });
    expect(within(bar).getByRole("status")).toHaveTextContent("Not looked for yet");
    click("Detect");
    expect(await within(bar).findByText("T48, firmware 00.1.03")).toBeInTheDocument();
    expect(within(bar).getByRole("alert")).toHaveTextContent("Firmware is out of date");
    expect(
      within(bar).getByRole("heading", { name: /T48 support is not yet complete/ }),
    ).toBeInTheDocument();
    // With a programmer on USB there's no model to choose.
    expect(within(bar).queryByRole("combobox")).toBeNull();
    expect(button("Detect again")).toBeEnabled();
  });

  it("tells a T76 owner about the algorithm file and lets them choose their own", async () => {
    const { fake, dialogs } = setup({
      programmer: {
        programmer: "T76",
        firmware: "00.1.17",
        chip: null,
        firmware_status: null,
        firmware_expected: null,
        support_warning: "T76 support is experimental!",
      },
      algorithmFiles: ["/home/me/xgecu/algorithm.xml"],
    });
    click("Detect");
    const bar = screen.getByRole("region", { name: "Programmer" });
    const alert = await within(bar).findByRole("alert");
    expect(alert).toHaveTextContent("No algorithm file for the T76");
    expect(alert).toHaveTextContent("XGecu's algorithm.xml, a file from the Xgpro package");
    expect(alert).toHaveTextContent("burnwright doesn't ship or download it");
    expect(alert).toHaveTextContent("/usr/local/share/minipro/algorithm.xml");
    expect(within(bar).getByText("none chosen")).toBeInTheDocument();
    expect(within(bar).queryByRole("button", { name: "Clear" })).toBeNull();

    dialogs.openAlgorithms.mockResolvedValue("/home/me/xgecu/algorithm.xml");
    click("Choose file…");
    expect(
      await within(bar).findByText("/home/me/xgecu/algorithm.xml (chosen here)"),
    ).toBeInTheDocument();
    expect(fake.algorithmPath).toBe("/home/me/xgecu/algorithm.xml");
    // Nothing left to warn about.
    expect(within(bar).queryByRole("alert")).toBeNull();

    click("Clear");
    expect(await within(bar).findByText("none chosen")).toBeInTheDocument();
    expect(within(bar).getByRole("alert")).toHaveTextContent("No algorithm file for the T76");
  });

  it("holds the file buttons while the algorithm file is being chosen", async () => {
    const { dialogs } = setup({
      programmer: {
        programmer: "T76",
        firmware: "00.1.17",
        chip: null,
        firmware_status: null,
        firmware_expected: null,
        support_warning: null,
      },
      algorithmFiles: ["/home/me/xgecu/algorithm.xml"],
    });
    click("Detect");
    const bar = screen.getByRole("region", { name: "Programmer" });
    await within(bar).findByText("none chosen");
    let pick: (path: string | null) => void = () => {};
    dialogs.openAlgorithms.mockReturnValue(
      new Promise<string | null>((resolve) => {
        pick = resolve;
      }),
    );

    click("Choose file…");
    await waitFor(() => expect(button("Choose file…")).toBeDisabled());
    expect(button("Open…")).toBeDisabled();

    await act(async () => {
      pick("/home/me/xgecu/algorithm.xml");
    });
    await within(bar).findByText("/home/me/xgecu/algorithm.xml (chosen here)");
    expect(button("Choose file…")).toBeEnabled();
    expect(button("Clear")).toBeEnabled();
    expect(button("Open…")).toBeEnabled();
  });

  it("says in the panel when the remembered algorithm file couldn't be applied", async () => {
    const fake = createFakeEngine({
      chips: CHIPS,
      programmer: {
        programmer: "T76",
        firmware: "00.1.17",
        chip: null,
        firmware_status: null,
        firmware_expected: null,
        support_warning: null,
      },
      algorithmFile: "/usr/local/share/minipro/algorithm.xml",
    });
    fake.setAlgorithmPath = () => Promise.reject(new Error("the engine isn't answering"));
    const dialogs = {
      open: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
      save: vi.fn<(suggested: string) => Promise<string | null>>().mockResolvedValue(null),
      openAlgorithms: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
    };
    const controller = new DeviceController({
      engine: fake,
      dialogs,
      settings: {
        loadAlgorithmPath: () => "/home/me/xgecu/algorithm.xml",
        saveAlgorithmPath: () => {},
      },
    });
    render(<DeviceScreen controller={controller} footer="burnwright test" />);
    click("Detect");
    const bar = screen.getByRole("region", { name: "Programmer" });
    const alert = await within(bar).findByRole("alert");
    expect(alert).toHaveTextContent(
      "burnwright couldn't apply the algorithm file remembered from last time (/home/me/xgecu/algorithm.xml): the engine isn't answering.",
    );
    expect(alert).toHaveTextContent("Until it's chosen again");
    // The way out is right under it.
    expect(within(bar).getByRole("button", { name: "Choose file…" })).toBeEnabled();
  });

  it("has no algorithm file control for a programmer that carries its own", async () => {
    setup();
    click("Detect");
    const bar = screen.getByRole("region", { name: "Programmer" });
    await within(bar).findByText("T48, firmware 01.1.32");
    expect(within(bar).queryByText("Algorithm file")).toBeNull();
    expect(within(bar).queryByRole("button", { name: "Choose file…" })).toBeNull();
  });

  it("says why there's no programmer and lets you choose a chip list", async () => {
    const { fake } = setup({ programmer: null });
    click("Detect");
    const bar = screen.getByRole("region", { name: "Programmer" });
    expect(
      await within(bar).findByRole("heading", { name: "No programmer plugged in" }),
    ).toBeInTheDocument();
    expect(within(bar).getByRole("status")).toHaveTextContent(/^No programmer found$/);

    const model = within(bar).getByRole("combobox", { name: "Show the chip list for" });
    expect(model).toHaveValue("t48");
    const searchChips = vi.spyOn(fake, "searchChips");
    fireEvent.change(model, { target: { value: "t76" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Search the T76 chip list" }), {
      target: { value: "flash" },
    });
    expect(searchChips).toHaveBeenCalledWith("t76", "flash", 30);

    // No programmer, no operations: and the screen says so.
    for (const name of ["Read", "Verify", "Blank check", "Check chip", "Erase", "Write"]) {
      expect(button(name)).toBeDisabled();
    }
    expect(within(operations()).getByText("No programmer detected.")).toBeInTheDocument();
  });
});

describe("chip picker", () => {
  it("searches as you type, with package and size, and picks with the keyboard", async () => {
    setup();
    fireEvent.change(search(), { target: { value: "32" } });
    const options = within(await screen.findByRole("listbox")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("FLASH32@SOIC8"),
      expect.stringContaining("OTHER32@SOIC8"),
    ]);
    await waitFor(() => expect(options[1]).toHaveTextContent("OTHER32@SOIC8SOIC832 bytes"));
    expect(screen.getByText("2 matches.")).toBeInTheDocument();
    expect(search()).toHaveAttribute("aria-expanded", "true");
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(search(), { key: "ArrowDown" });
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(search()).toHaveAttribute("aria-activedescendant", options[1].id);
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(search(), { key: "ArrowUp" });
    fireEvent.keyDown(search(), { key: "Enter" });

    const chip = screen.getByRole("region", { name: "Chip" });
    expect(await within(chip).findByRole("heading", { name: "OTHER32@SOIC8" })).toBeInTheDocument();
    expect(search()).toHaveValue("");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(await within(chip).findByText("32 bytes")).toBeInTheDocument();
    expect(
      within(chip).getByText("In the ZIF socket through a plain SOIC8 to DIP adapter (8 pins)."),
    ).toBeInTheDocument();
    expect(within(chip).getByText("TL866II+, T48 and T56")).toBeInTheDocument();
  });

  it("clears the search with Escape and says when nothing matches", async () => {
    setup();
    fireEvent.change(search(), { target: { value: "zzz" } });
    expect(
      await screen.findByText("No chip in the T48 list matches “zzz”."),
    ).toBeInTheDocument();
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(search()).toHaveValue("");
  });

  it("offers recent chips again", async () => {
    setup();
    await pick("EEPROM16");
    await pick("FLASH32@SOIC8");
    const chip = screen.getByRole("region", { name: "Chip" });
    expect(within(chip).getByRole("button", { name: "FLASH32@SOIC8" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(within(chip).getByRole("button", { name: "EEPROM16" }));
    expect(await within(chip).findByRole("heading", { name: "EEPROM16" })).toBeInTheDocument();
  });

  it("warns when the connected programmer isn't one minipro lists for the chip", async () => {
    setup();
    await pick("T56ONLY");
    expect(
      await screen.findByText(/minipro lists T56ONLY for the T56, not the T48/),
    ).toBeInTheDocument();
  });

  it("shows minipro's message for an entry it can't read", async () => {
    setup({ socket: { chip: "EEPROM16", memory: ramp(16) } });
    await pick("AT28C256E");
    const chip = screen.getByRole("region", { name: "Chip" });
    expect(within(chip).getByRole("alert")).toHaveTextContent(
      "minipro can't read its database entry for AT28C256E: An error occurred while parsing XML database.",
    );
    expect(button("Read")).toBeDisabled();
    expect(
      within(operations()).getByText(
        "burnwright has no details for AT28C256E, so it can't work on it.",
      ),
    ).toBeInTheDocument();
  });

  it("turns the memory operations off for a logic IC and says why", async () => {
    setup();
    await pick("7400");
    for (const name of ["Read", "Verify", "Blank check", "Erase", "Write"]) {
      expect(button(name)).toBeDisabled();
    }
    expect(within(operations()).getByText(/7400 is a logic IC/)).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Chip" })).getByText("None: a logic IC"),
    ).toBeInTheDocument();
  });
});

describe("auto", () => {
  /** Two parts that share FLASH32@SOIC8's ID, as W25Q32BV, FV and JV do. */
  const TWINS: FakeChip[] = [
    ...CHIPS,
    { info: fakeChip("FLASH32B@SOIC8", 32), id: "0xEF4016" },
    { info: fakeChip("FLASH32@SOIC16", 32), id: "0xEF4016" },
  ];
  const autoPanel = () => screen.getByRole("region", { name: "Auto" });

  async function detect() {
    click(/^Detect/);
    await screen.findByText(/firmware 01\.1\.32$/);
  }

  it("lists the parts that answer with the chip's ID, and picks the one chosen", async () => {
    const { fake } = setup({
      chips: TWINS,
      socket: { chip: "FLASH32B@SOIC8", memory: ramp(32) },
    });
    await detect();
    click("Auto");
    const panel = await screen.findByRole("region", { name: "Auto" });
    expect(fake.calls[fake.calls.length - 1]).toEqual({ command: "detectSpi", pins: 8 });
    expect(within(panel).getByRole("status")).toHaveTextContent(
      "The chip answers 0xEF4016. 2 parts in minipro's list do: pick the one marked on the chip.",
    );
    // The 16-pin part shares the ID but not the layout.
    const parts = within(panel).getAllByRole("button", { name: /^FLASH32/ });
    expect(parts.map((b) => b.textContent)).toEqual(["FLASH32@SOIC8", "FLASH32B@SOIC8"]);

    const log = within(screen.getByRole("region", { name: "Log" })).getByRole("log");
    expect(within(log).getByText("Auto (8-pin SPI flash)")).toBeInTheDocument();
    expect(within(log).getByText("$ minipro -a 8")).toBeInTheDocument();
    expect(within(log).getByText("Autodetecting device (ID:0xEF4016)")).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "FLASH32B@SOIC8" }));
    await screen.findByRole("heading", { name: "FLASH32B@SOIC8" });
    expect(screen.queryByRole("region", { name: "Auto" })).toBeNull();
    await waitFor(() => expect(button("Check chip")).toBeEnabled());
  });

  it("asks in the pin count chosen", async () => {
    const { fake } = setup({
      chips: TWINS,
      socket: { chip: "FLASH32@SOIC16", memory: ramp(32) },
    });
    await detect();
    fireEvent.change(screen.getByRole("combobox", { name: "Pins on the SPI flash" }), {
      target: { value: "16" },
    });
    click("Auto");
    await screen.findByRole("region", { name: "Auto" });
    expect(fake.calls[fake.calls.length - 1]).toEqual({ command: "detectSpi", pins: 16 });
    expect(within(autoPanel()).getByRole("heading")).toHaveTextContent("Auto, 16 pins");
    expect(within(autoPanel()).getByRole("status")).toHaveTextContent(
      "The chip answers 0xEF4016. One part in minipro's list does.",
    );
  });

  it("says nothing answered when the ID reads all ones, and closes", async () => {
    setup({ socket: null });
    await detect();
    click("Auto");
    const panel = await screen.findByRole("region", { name: "Auto" });
    expect(within(panel).getByRole("status")).toHaveTextContent(
      "Nothing answered: the ID reads 0xFFFFFF. Check the chip is in the socket or adapter the right way round",
    );
    expect(within(panel).queryAllByRole("button", { name: /^FLASH/ })).toEqual([]);
    fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("region", { name: "Auto" })).toBeNull();
  });

  it("needs a programmer, and keeps the chip operations off while it reads", async () => {
    const { fake } = setup({ socket: { chip: "FLASH32@SOIC8", memory: ramp(32) } });
    expect(button("Auto")).toBeDisabled();
    expect(button("Auto")).toHaveAttribute("title", "Detect a programmer first.");
    await pick("FLASH32@SOIC8");
    expect(button("Auto")).toBeEnabled();

    fake.hold();
    click("Auto");
    expect(await screen.findByRole("button", { name: "Reading ID…" })).toBeDisabled();
    expect(button("Read")).toBeDisabled();
    act(() => fake.release());
    await screen.findByRole("region", { name: "Auto" });
    expect(button("Read")).toBeEnabled();
  });

  it("says why it failed, as the T76 does with no algorithm file", async () => {
    setup({
      programmer: {
        programmer: "T76",
        firmware: "00.1.17",
        chip: null,
        firmware_status: null,
        firmware_expected: null,
        support_warning: "T76 support is experimental!",
      },
      socket: { chip: "FLASH32@SOIC8", memory: ramp(32) },
    });
    click("Detect");
    await screen.findByText(/firmware 00\.1\.17$/);
    click("Auto");
    const panel = await screen.findByRole("region", { name: "Auto" });
    expect(within(panel).getByRole("alert")).toHaveTextContent("algorithm file");
  });
});

describe("the whole flow", () => {
  it("reads a chip, writes it back after a confirmation that names it, and verifies", async () => {
    const { fake, controller } = setup({
      socket: { chip: "EEPROM16", memory: ramp(16, 0x40) },
    });
    await pick("EEPROM16");
    expect(button("Verify")).toBeDisabled();

    click("Read");
    expect(await outcome("Read EEPROM16")).toHaveTextContent(
      "16 bytes from the chip are in the buffer.",
    );
    const buffer = screen.getByRole("region", { name: "Buffer" });
    expect(within(buffer).getByText("Read from EEPROM16")).toBeInTheDocument();
    // A read exists nowhere else until it's saved.
    expect(within(buffer).getByText("Not saved to a file")).toBeInTheDocument();
    expect(within(buffer).getByText("Same size as EEPROM16.")).toBeInTheDocument();
    expect(within(buffer).getByRole("grid", { name: "Buffer bytes" })).toBeInTheDocument();

    // An edit, as the hex editor reports it.
    const edited = ramp(16, 0x40);
    edited[2] = 0xaa;
    act(() => controller.editBuffer(edited, true));
    expect(within(buffer).getByText("Edited, not saved")).toBeInTheDocument();

    // From the keyboard, so there's a focus to give back.
    button("Write").focus();
    click("Write");
    const dialog = screen.getByRole("alertdialog", { name: "Write to EEPROM16?" });
    expect(dialog).toHaveTextContent("This replaces what's on EEPROM16 with the buffer (16 bytes).");
    // Backing out is the default, and Escape takes it.
    expect(within(dialog).getByRole("button", { name: "Don't write" })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fake.calls.some((c) => c.command === "write")).toBe(false);
    expect(button("Write")).toHaveFocus();

    click("Write");
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Write EEPROM16" }),
    );
    expect(await outcome("Wrote EEPROM16")).toBeInTheDocument();
    expect(fake.socket?.memory).toEqual(edited);

    click("Verify");
    expect(await outcome("Verify passed")).toHaveTextContent("EEPROM16 matches the buffer.");
    expect(screen.queryByRole("region", { name: "Differences" })).toBeNull();
  });

  it("keeps Tab inside the confirmation", async () => {
    setup({ socket: { chip: "EEPROM16", memory: ramp(16) } });
    await pick("EEPROM16");
    click("Erase");
    const dialog = screen.getByRole("alertdialog", { name: "Erase EEPROM16?" });
    const stay = within(dialog).getByRole("button", { name: "Don't erase" });
    const go = within(dialog).getByRole("button", { name: "Erase EEPROM16" });
    expect(stay).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(go).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(stay).toHaveFocus();
    fireEvent.click(stay);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("hands the focus to Cancel when the button that opened the dialog is disabled", async () => {
    const { fake } = setup({ socket: { chip: "EEPROM16", memory: ramp(16) } });
    await pick("EEPROM16");
    fake.hold();
    // By keyboard: Erase has the focus, the dialog takes it and gives it back.
    button("Erase").focus();
    click("Erase");
    fireEvent.click(screen.getByRole("button", { name: "Erase EEPROM16" }));
    // Erase is disabled while it runs, so the focus goes to the way out.
    expect(button("Erase")).toBeDisabled();
    expect(button("Cancel")).toHaveFocus();

    // Stopping disables Cancel too: the focus stays in the operations panel.
    click("Cancel");
    fireEvent.click(screen.getByRole("button", { name: "Stop the erase" }));
    expect(button("Stopping…")).toBeDisabled();
    expect(operations()).toHaveFocus();
    act(() => fake.release());
    expect(await outcome("Erase cancelled")).toHaveTextContent("may be half-erased");
  });

  it("turns the file buttons off while an operation runs or a file is on its way", async () => {
    const { fake, dialogs } = setup({
      files: { "/image.bin": ramp(16) },
      socket: { chip: "EEPROM16", memory: ramp(16) },
    });
    await pick("EEPROM16");
    await openFile(dialogs, "/image.bin");
    expect(button("Save")).toBeEnabled();

    let choose: (path: string | null) => void = () => {};
    dialogs.open.mockReturnValue(
      new Promise((resolve) => {
        choose = resolve;
      }),
    );
    click("Open…");
    expect(button("Open…")).toBeDisabled();
    expect(button("Save")).toBeDisabled();
    expect(button("Write")).toBeDisabled();
    expect(within(operations()).getByText("A file is being opened.")).toBeInTheDocument();
    await act(async () => choose(null));
    expect(button("Write")).toBeEnabled();

    fake.hold();
    click("Read");
    expect(button("Save")).toBeDisabled();
    expect(button("Save as…")).toBeDisabled();
    act(() => fake.release());
    await outcome("Read EEPROM16");
    expect(button("Save")).toBeEnabled();
  });

  it("shows progress and a Cancel button while an operation runs", async () => {
    const { fake } = setup({ socket: { chip: "EEPROM16", memory: ramp(16) } });
    await pick("EEPROM16");
    fake.hold();
    click("Read");
    const ops = operations();
    expect(await within(ops).findByText("Read EEPROM16: Reading Code")).toBeInTheDocument();
    expect(within(ops).getByRole("progressbar", { name: "Read progress" })).toBeInTheDocument();
    // Everything else waits.
    expect(button("Write")).toBeDisabled();
    expect(button("Open…")).toBeDisabled();
    expect(search()).toBeDisabled();

    click("Cancel");
    expect(button("Stopping…")).toBeDisabled();
    act(() => fake.release());
    expect(await outcome("Read cancelled")).toHaveTextContent("Nothing on the chip changed.");
  });

  it("asks before stopping a write and warns that the chip is half-programmed", async () => {
    const { fake, dialogs } = setup({
      files: { "/image.bin": ramp(16, 1) },
      socket: { chip: "EEPROM16", memory: new Uint8Array(16) },
    });
    await pick("EEPROM16");
    await openFile(dialogs, "/image.bin");
    fake.hold();
    click("Write");
    fireEvent.click(screen.getByRole("button", { name: "Write EEPROM16" }));
    await screen.findByText(/^Write EEPROM16: /);

    click("Cancel");
    const dialog = screen.getByRole("alertdialog", { name: "Stop the write?" });
    expect(dialog).toHaveTextContent("Stopping now leaves EEPROM16 half-programmed.");
    expect(within(dialog).getByRole("button", { name: "Keep writing" })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop the write" }));
    act(() => fake.release());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Write cancelled");
    expect(alert).toHaveTextContent(
      "EEPROM16 may be half-programmed. Erase it or write it again before trusting what's on it.",
    );
  });

  it("opens the differences after a failed verify", async () => {
    const onChip = ramp(16);
    onChip[5] = 0xee;
    const { dialogs } = setup({
      files: { "/image.bin": ramp(16) },
      socket: { chip: "EEPROM16", memory: onChip },
    });
    await pick("EEPROM16");
    await openFile(dialogs, "/image.bin");
    click("Verify");
    expect(await outcome("Verify failed")).toHaveTextContent(
      "Verification failed at address 0x0005: File=0x05, Device=0xEE.",
    );
    const diff = await screen.findByRole("region", { name: "Differences" });
    expect(within(diff).getByRole("heading", { name: "EEPROM16 against the buffer" })).toBeInTheDocument();
    expect(within(diff).getByText("1 byte differs")).toBeInTheDocument();
    fireEvent.click(within(diff).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("region", { name: "Differences" })).toBeNull();
  });
});

describe("safety", () => {
  it("shows a size mismatch in the buffer panel and again before the write", async () => {
    const { fake, dialogs } = setup({
      files: { "/short.bin": ramp(10, 0x80) },
      socket: { chip: "EEPROM16", memory: new Uint8Array(16).fill(0xff) },
    });
    await pick("EEPROM16");
    await openFile(dialogs, "/short.bin");
    const buffer = screen.getByRole("region", { name: "Buffer" });
    expect(within(buffer).getByRole("alert")).toHaveTextContent(
      "Size mismatch: 6 bytes smaller than EEPROM16, which holds 16 bytes. burnwright never pads or cuts the buffer",
    );

    click("Write");
    const dialog = screen.getByRole("alertdialog", { name: "Write to EEPROM16?" });
    expect(dialog).toHaveTextContent("The buffer is 10 bytes and the chip holds 16 bytes: 6 bytes short.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Don't write" }));
    expect(fake.calls.some((c) => c.command === "write")).toBe(false);

    click("Write");
    fireEvent.click(screen.getByRole("button", { name: "Write EEPROM16 anyway" }));
    expect(await outcome("Wrote EEPROM16")).toHaveTextContent("The size check was off");
    expect(Array.from(fake.socket?.memory ?? [])).toEqual([
      ...ramp(10, 0x80),
      ...new Array(6).fill(0xff),
    ]);
  });

  it("says plainly when a chip has no size to check the buffer against", async () => {
    const { dialogs } = setup({
      files: { "/image.bin": ramp(10) },
      socket: { chip: "NAND@SOP16", memory: new Uint8Array(64) },
    });
    await pick("NAND@SOP16");
    await openFile(dialogs, "/image.bin");
    const buffer = screen.getByRole("region", { name: "Buffer" });
    expect(
      within(buffer).getByText(
        "Size not checked: minipro gives no image size for NAND@SOP16, so there is nothing to compare the buffer with.",
      ),
    ).toBeInTheDocument();
    expect(within(buffer).queryByRole("alert")).toBeNull();
    expect(button("Write")).toBeEnabled();
    click("Write");
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "burnwright hasn't checked the buffer against it",
    );
  });

  it("reports a chip ID mismatch as its own error, with minipro's override", async () => {
    const { fake } = setup({ socket: { chip: "OTHER32@SOIC8", memory: ramp(32) } });
    await pick("FLASH32@SOIC8");
    click("Read");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Chip ID mismatch");
    expect(alert).toHaveTextContent("Expected 0xEF4016, found 0xC22016 (OTHER32@SOIC8).");
    expect(alert).toHaveTextContent("Nothing was read.");
    fireEvent.click(
      within(alert).getByRole("button", { name: "Read anyway, ignoring the chip ID" }),
    );
    expect(await outcome("Read FLASH32@SOIC8")).toBeInTheDocument();
    expect(fake.calls[fake.calls.length - 1]).toMatchObject({
      command: "read",
      options: { ignoreChipId: true },
    });
  });

  it("asks before a read replaces unsaved edits", async () => {
    const { controller } = setup({ socket: { chip: "EEPROM16", memory: ramp(16) } });
    await pick("EEPROM16");
    click("Read");
    await outcome("Read EEPROM16");
    const edited = ramp(16);
    edited[0] = 0x99;
    act(() => controller.editBuffer(edited, true));
    click("Read");
    const dialog = screen.getByRole("alertdialog", { name: "Replace the buffer?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep the buffer" }));
    expect(controller.getState().buffer?.bytes).toEqual(edited);
  });
});

describe("buffer files", () => {
  it("opens, saves and reports a file that won't open", async () => {
    const { fake, dialogs } = setup({ files: { "/roms/image.bin": ramp(16) } });
    const buffer = screen.getByRole("region", { name: "Buffer" });
    expect(
      within(buffer).getByText("The buffer is empty. Open a .bin or Intel HEX file, or read a chip."),
    ).toBeInTheDocument();
    expect(button("Save")).toBeDisabled();

    await openFile(dialogs, "/roms/image.bin");
    expect(within(buffer).getByText("image.bin")).toBeInTheDocument();
    expect(within(buffer).getByText("16 bytes")).toBeInTheDocument();

    dialogs.save.mockResolvedValue("/roms/copy.hex");
    click("Save as…");
    await waitFor(() => expect(fake.saved["/roms/copy.hex"]).toEqual(ramp(16)));
    expect(await within(buffer).findByText("copy.hex")).toBeInTheDocument();

    dialogs.open.mockResolvedValue("/roms/missing.bin");
    click("Open…");
    expect(await within(buffer).findByRole("alert")).toHaveTextContent(
      "Couldn't open missing.bin: /roms/missing.bin: No such file or directory (os error 2)",
    );
    // The buffer that was there is still there.
    expect(within(buffer).getByText("copy.hex")).toBeInTheDocument();
  });
});

describe("what's inside the buffer", () => {
  const GZIP = [0x1f, 0x8b, 0x08, 0x00];
  /** 64 erased bytes with a gzip header at 16. */
  const image = () => {
    const data = new Uint8Array(64).fill(0xff);
    data.set(GZIP, 16);
    return data;
  };
  const contents = () => screen.findByRole("region", { name: "Contents" });

  async function withFile(file: Uint8Array = image()) {
    const rig = setup({ files: { "/img.bin": file } });
    await openFile(rig.dialogs, "/img.bin");
    return rig;
  }

  it("has nothing to inspect until there's a buffer", () => {
    setup();
    expect(button("Inspect")).toBeDisabled();
    expect(screen.queryByRole("region", { name: "Contents" })).toBeNull();
  });

  it("lists what the scan found, and a row puts the cursor on it", async () => {
    await withFile();
    expect(screen.queryByRole("region", { name: "Contents" })).toBeNull();
    click("Inspect");
    const panel = await contents();
    const row = (await within(panel).findByText("gzip")).closest("tr") as HTMLElement;
    expect(within(panel).getByText(/^1 found in 64 bytes\./)).toBeInTheDocument();
    expect(row).toHaveTextContent("0x00000010");
    expect(row).toHaveTextContent("unknown");
    expect(row).toHaveTextContent("Medium");
    expect(row).toHaveTextContent("gzip compressed data, operating system: Unix");

    const value = () => document.querySelector(".hexedit-value");
    expect(value()).toHaveTextContent(/0+ = FF$/);
    // The button is what a keyboard reaches; a click anywhere on the row
    // does the same.
    fireEvent.click(within(row).getByRole("button", { name: "Go to 0x00000010, gzip" }));
    expect(value()).toHaveTextContent(/0+10 = 1F$/);
    fireEvent.click(screen.getByRole("grid", { name: "Buffer bytes" }));
    fireEvent.click(within(row).getByText("Medium"));
    expect(value()).toHaveTextContent(/0+10 = 1F$/);
  });

  it("says so when there's nothing it knows in the buffer", async () => {
    await withFile(new Uint8Array(32).fill(0xff));
    click("Inspect");
    const panel = await contents();
    expect(await within(panel).findByText("Nothing recognised in these 32 bytes.")).toBeInTheDocument();
    expect(within(panel).queryByRole("table")).toBeNull();
    expect(within(panel).queryByRole("alert")).toBeNull();
  });

  it("shows a scan that died as a failure, and scans again when asked", async () => {
    const { fake } = await withFile();
    fake.scan = () => {
      throw {
        kind: "scan_failed",
        message: "the scan stopped without a result: signal: 6 (SIGABRT)",
        device_state: null,
      };
    };
    click("Inspect");
    const panel = await contents();
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent(
      "The scan stopped without a result: signal: 6 (SIGABRT). That\u2019s the scan failing, not an empty result.",
    );
    expect(within(panel).queryByText(/Nothing recognised/)).toBeNull();

    fake.scan = (data) => ({
      len: data.length,
      findings: [],
      entropy: entropyOf(data),
      strings: stringsOf(data),
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Scan again" }));
    expect(await within(panel).findByText(/Nothing recognised/)).toBeInTheDocument();
    expect(within(panel).queryByRole("alert")).toBeNull();
  });

  it("can be cancelled while it runs", async () => {
    const { fake } = await withFile();
    fake.hold();
    click("Inspect");
    const panel = await contents();
    expect(within(panel).getByRole("status")).toHaveTextContent("Scanning 64 bytes…");
    expect(button("Inspect")).toBeDisabled();
    fireEvent.click(within(panel).getByRole("button", { name: "Cancel scan" }));
    fake.release();
    expect(await within(panel).findByText("Scan cancelled.")).toBeInTheDocument();
    expect(button("Inspect")).toBeEnabled();
  });

  it("warns that the report is old once the buffer is edited", async () => {
    const { controller } = await withFile();
    click("Inspect");
    const panel = await contents();
    await within(panel).findByText("gzip");
    expect(within(panel).queryByRole("alert")).toBeNull();

    const edited = image();
    edited[16] = 0x00;
    act(() => controller.editBuffer(edited, true));
    expect(within(panel).getByRole("alert")).toHaveTextContent(
      "The buffer has been edited since this scan.",
    );
    // The old rows stay up to look at.
    expect(within(panel).getByText("gzip")).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Scan again" }));
    expect(await within(panel).findByText(/Nothing recognised/)).toBeInTheDocument();
    expect(within(panel).queryByRole("alert")).toBeNull();
  });

  it("draws the first 500 of a very long report and says how many there were", async () => {
    const { fake } = await withFile();
    fake.scan = (data) => ({
      len: data.length,
      entropy: entropyOf(data),
      strings: stringsOf(data),
      findings: Array.from({ length: 620 }, (_, i) => ({
        offset: i % 64,
        size: null,
        kind: "gzip",
        description: `stream ${i}`,
        confidence: "low" as const,
      })),
    });
    click("Inspect");
    const panel = await contents();
    expect(await within(panel).findByText("Showing the first 500 of 620.")).toBeInTheDocument();
    const formats = within(panel).getByRole("table", { name: "Formats found" });
    expect(within(formats).getAllByRole("row")).toHaveLength(501);
    expect(within(panel).getByText("stream 499")).toBeInTheDocument();
    expect(within(panel).queryByText("stream 500")).toBeNull();
  });

  it("draws the buffer's entropy, and a point on the strip puts the cursor there", async () => {
    // Four blocks of 256: erased, every byte value once, erased, two values.
    const data = new Uint8Array(1024).fill(0xff);
    for (let i = 0; i < 256; i++) data[256 + i] = i;
    for (let i = 0; i < 256; i++) data[768 + i] = i % 2;
    await withFile(data);
    click("Inspect");
    const panel = await contents();
    const strip = await within(panel).findByRole("slider", { name: "Entropy across the buffer" });
    expect(strip).toHaveAttribute("aria-valuemax", "3");
    expect(panel).toHaveTextContent("Entropy of each 256 bytes, from 0 to 8 bits a byte.");
    expect(panel).toHaveTextContent("50% of the buffer is flat, the way erased flash reads.");
    // Still says there's no format it knows: the strip isn't a finding.
    expect(within(panel).getByText("Nothing recognised in these 1,024 bytes.")).toBeInTheDocument();

    const value = () => document.querySelector(".hexedit-value");
    strip.getBoundingClientRect = () => ({ left: 100, width: 400 }) as DOMRect;
    fireEvent.click(strip, { clientX: 100 + 400 * 0.3 });
    expect(value()).toHaveTextContent(/0+100 = 00$/);
    expect(within(panel).getByText("0x00000100, 8.00 bits a byte")).toBeInTheDocument();

    fireEvent.keyDown(strip, { key: "End" });
    expect(strip).toHaveAttribute("aria-valuetext", "0x00000300, 1.00 bits a byte");
    // Stepping along it reads blocks out; only Enter moves the cursor.
    expect(value()).toHaveTextContent(/0+100 = 00$/);
    fireEvent.keyDown(strip, { key: "Enter" });
    expect(value()).toHaveTextContent(/0+300 = 00$/);
  });

  it("lists the buffer's strings, and a row puts the cursor on one", async () => {
    const data = new Uint8Array(256).fill(0xff);
    const put = (at: number, text: string) => data.set(new TextEncoder().encode(text), at);
    put(0x20, "U-Boot 2019.07");
    put(0x60, "console=ttyS0,115200");
    put(0xa0, "root=/dev/mtdblock2");
    await withFile(data);
    click("Inspect");
    const panel = await contents();
    const table = await within(panel).findByRole("table", { name: "Strings" });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(panel).toHaveTextContent("3 strings. Pick one to go to it in the buffer.");
    // Text isn't a format: the scan still says it knows none of this.
    expect(within(panel).getByText("Nothing recognised in these 256 bytes.")).toBeInTheDocument();

    const value = () => document.querySelector(".hexedit-value");
    fireEvent.click(within(table).getByText("console=ttyS0,115200"));
    expect(value()).toHaveTextContent(/0+60 = 63$/);

    fireEvent.change(within(panel).getByRole("searchbox", { name: "Filter strings" }), {
      target: { value: "mtd" },
    });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    fireEvent.click(
      within(table).getByRole("button", { name: "Go to 0x000000A0, root=/dev/mtdblock2" }),
    );
    expect(value()).toHaveTextContent(/0+A0 = 72$/);
  });

  it("says a buffer with no text in it has none", async () => {
    await withFile();
    click("Inspect");
    const panel = await contents();
    await within(panel).findByText("gzip");
    expect(within(panel).getByText("No text of 4 characters or more in these bytes.")).toBeInTheDocument();
    expect(within(panel).queryByRole("table", { name: "Strings" })).toBeNull();
  });

  describe("saving what it found", () => {
    const UIMAGE = [0x27, 0x05, 0x19, 0x56];
    /** 128 bytes counting up, with a uImage header at 16 and a gzip stream at 100. */
    const dump = () => {
      const data = Uint8Array.from({ length: 128 }, (_, i) => 0x80 + i);
      data.set(UIMAGE, 16);
      data.set(GZIP, 100);
      return data;
    };
    const saveButton = (panel: HTMLElement) =>
      within(panel).findByRole("button", { name: "Save the uimage at 0x00000010 as…" });

    it("saves a format that says how long it is, as a file of its own", async () => {
      const { fake, dialogs, controller } = await withFile(dump());
      click("Inspect");
      const panel = await contents();
      const save = await saveButton(panel);
      expect(save).toHaveAttribute("title", "Save these 64 bytes to a file");
      expect(panel).toHaveTextContent("Save… writes one out as a file of its own.");
      // The gzip stream doesn't say where it ends: nothing to save.
      expect(within(panel).getAllByRole("button", { name: /^Save the / })).toHaveLength(1);

      dialogs.save.mockResolvedValue("/out/header.bin");
      fireEvent.click(save);
      await waitFor(() => expect(fake.saved["/out/header.bin"]).toEqual(dump().slice(16, 80)));
      expect(dialogs.save).toHaveBeenCalledExactlyOnceWith("/img-0x10-uimage.bin", "region");
      expect(
        await within(screen.getByRole("log")).findByText(
          "Saved 64 bytes from 0x00000010 (uimage) to /out/header.bin.",
        ),
      ).toBeInTheDocument();
      // The button isn't the row: the cursor stays where it was.
      expect(document.querySelector(".hexedit-value")).toHaveTextContent(/0+ = 80$/);
      // And the buffer is still the file it was opened from.
      expect(controller.getState().buffer?.path).toBe("/img.bin");
      const buffer = screen.getByRole("region", { name: "Buffer" });
      expect(within(buffer).getByText("img.bin")).toBeInTheDocument();
    });

    it("has no File column when nothing found says how long it is", async () => {
      await withFile();
      click("Inspect");
      const panel = await contents();
      await within(panel).findByText("gzip");
      expect(within(panel).queryByRole("columnheader", { name: "File" })).toBeNull();
      expect(within(panel).queryByRole("button", { name: /^Save the / })).toBeNull();
      expect(panel).not.toHaveTextContent("Save… writes");
    });

    it("won't save from a report the buffer has moved on from", async () => {
      const { controller, dialogs } = await withFile(dump());
      click("Inspect");
      const panel = await contents();
      const save = await saveButton(panel);
      expect(save).toBeEnabled();

      const edited = dump();
      edited[20] = 0x00;
      act(() => controller.editBuffer(edited, true));
      expect(save).toBeDisabled();
      expect(save).toHaveAttribute(
        "title",
        "The buffer has been edited since this scan. Scan again first.",
      );
      fireEvent.click(save);
      expect(dialogs.save).not.toHaveBeenCalled();

      fireEvent.click(within(panel).getByRole("button", { name: "Scan again" }));
      await waitFor(async () => expect(await saveButton(panel)).toBeEnabled());
    });

    it("says why when the file can't be written", async () => {
      const { fake, dialogs } = await withFile(dump());
      click("Inspect");
      const panel = await contents();
      dialogs.save.mockResolvedValue("/readonly/header.bin");
      fake.saveImage = async () => {
        throw new Error("/readonly/header.bin: Permission denied (os error 13)");
      };
      fireEvent.click(await saveButton(panel));
      const buffer = screen.getByRole("region", { name: "Buffer" });
      expect(await within(buffer).findByRole("alert")).toHaveTextContent(
        "Couldn't save header.bin: /readonly/header.bin: Permission denied (os error 13)",
      );
    });
  });

  it("closes, and goes away with the buffer it was about", async () => {
    const { dialogs, fake } = await withFile();
    click("Inspect");
    let panel = await contents();
    await within(panel).findByText("gzip");
    fireEvent.click(within(panel).getByRole("button", { name: "Close contents" }));
    expect(screen.queryByRole("region", { name: "Contents" })).toBeNull();

    click("Inspect");
    panel = await contents();
    await within(panel).findByText("gzip");
    fake.saved["/other.bin"] = Uint8Array.of(1, 2, 3);
    dialogs.open.mockResolvedValue("/other.bin");
    click("Open…");
    await screen.findByText("other.bin");
    expect(screen.queryByRole("region", { name: "Contents" })).toBeNull();
  });
});

describe("log pane", () => {
  it("shows each operation's command line and output, and copies it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    setup({ socket: { chip: "EEPROM16", memory: ramp(16) } });
    const log = screen.getByRole("region", { name: "Log" });
    expect(button("Copy log")).toBeDisabled();
    await pick("EEPROM16");
    click("Blank check");
    await outcome("Chip is not blank");

    const lines = within(log).getByRole("log");
    expect(within(lines).getByText("Blank check EEPROM16")).toBeInTheDocument();
    expect(within(lines).getByText("$ minipro -p EEPROM16 -b")).toBeInTheDocument();
    expect(within(lines).getByText("Reading Code: done in 0.5 s")).toBeInTheDocument();

    click("Copy log");
    expect(await within(log).findByText("Copied")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("== Blank check EEPROM16 ==\n$ minipro -p EEPROM16 -b\n"),
    );

    click("Clear log");
    expect(within(lines).getByText(/^Nothing yet\./)).toBeInTheDocument();
  });

  it("says so when copying fails", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
      configurable: true,
    });
    setup();
    click("Detect");
    await screen.findByText(/firmware 01\.1\.32$/);
    click("Copy log");
    expect(
      await screen.findByText("Couldn't copy: select the text instead."),
    ).toBeInTheDocument();
  });
});

describe("with file paths hidden", () => {
  const SECRET = "/home/me/customers/Jane Doe/bios dump.bin";
  const ALGORITHMS = "/home/me/xgecu/algorithm.xml";

  /** Everything the window shows: its text, and what hovering would show. */
  function shown(): string {
    const titles = [...document.querySelectorAll("[title]")].map((el) => el.getAttribute("title"));
    return [document.body.textContent, ...titles].join("\n");
  }

  function expectNoPaths() {
    for (const secret of ["/home", "Jane", "Doe", "customers", "xgecu", "bios dump", "/tmp", "/usr"]) {
      expect(shown(), secret).not.toContain(secret);
    }
  }

  function setupHidden(options: FakeEngineOptions = {}) {
    const fake = createFakeEngine({ chips: CHIPS, ...options });
    const dialogs = {
      open: vi.fn<() => Promise<string | null>>().mockResolvedValue(SECRET),
      save: vi.fn<(suggested: string) => Promise<string | null>>().mockResolvedValue(null),
      openAlgorithms: vi.fn<() => Promise<string | null>>().mockResolvedValue(ALGORITHMS),
    };
    const controller = new DeviceController({ engine: fake, dialogs });
    const view = render(<DeviceScreen controller={controller} hidePaths />);
    const show = (hidePaths: boolean) =>
      view.rerender(<DeviceScreen controller={controller} hidePaths={hidePaths} />);
    return { fake, dialogs, controller, show };
  }

  it("hides the opened file in the buffer panel, its tooltip and the log", async () => {
    const { controller, fake } = setupHidden({
      socket: { chip: "FLASH32@SOIC8", memory: ramp(32) },
      files: { [SECRET]: ramp(32) },
    });
    await pick("FLASH32@SOIC8");
    click("Open…");
    await screen.findByRole("grid", { name: "Buffer bytes" });
    click("Verify");
    await outcome("Verify passed");

    const buffer = screen.getByRole("region", { name: "Buffer" });
    expect(within(buffer).getByText("[hidden].bin")).toHaveAttribute("title", "[hidden].bin");
    const log = screen.getByRole("log");
    expect(within(log).getByText("Opened [hidden].bin: 32 bytes.")).toBeInTheDocument();
    expectNoPaths();
    // The chip, the operation and its output are all still there.
    expect(within(log).getByText(/^\$ minipro -p FLASH32@SOIC8/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "FLASH32@SOIC8" })).toBeInTheDocument();

    // Only the drawing is masked: the engine was handed the real file.
    expect(controller.getState().buffer?.path).toBe(SECRET);
    expect(fake.calls.some((call) => JSON.stringify(call).includes(SECRET))).toBe(true);
  });

  it("hides a save's path, and a failed open's", async () => {
    const { dialogs } = setupHidden({
      socket: { chip: "FLASH32@SOIC8", memory: ramp(32) },
      files: { [SECRET]: ramp(32) },
    });
    await pick("FLASH32@SOIC8");
    click("Read");
    await outcome("Read FLASH32@SOIC8");
    dialogs.save.mockResolvedValue("/home/me/customers/Jane Doe/read back.bin");
    click("Save as…");
    await within(screen.getByRole("log")).findByText("Saved 32 bytes to [hidden].bin.");
    expectNoPaths();

    dialogs.open.mockResolvedValue("/home/me/customers/Jane Doe/missing.bin");
    click("Open…");
    await screen.findByRole("alert");
    expectNoPaths();
  });

  it("hides the T76's algorithm file, chosen or not", async () => {
    setupHidden({
      programmer: {
        programmer: "T76",
        firmware: "00.1.17",
        chip: null,
        firmware_status: null,
        firmware_expected: null,
        support_warning: null,
      },
      algorithmFiles: [ALGORITHMS],
    });
    click("Detect");
    const bar = screen.getByRole("region", { name: "Programmer" });
    const alert = await within(bar).findByRole("alert");
    // The file's own name is no secret; where minipro looks for it is.
    expect(alert).toHaveTextContent("XGecu's algorithm.xml");
    expect(alert).toHaveTextContent("[hidden].xml");
    expectNoPaths();

    click("Choose file…");
    expect(await within(bar).findByText("[hidden].xml (chosen here)")).toBeInTheDocument();
    expectNoPaths();
  });

  it("shows the real paths again when it's turned off, old log lines included", async () => {
    const { show } = setupHidden({
      socket: { chip: "FLASH32@SOIC8", memory: ramp(32) },
      files: { [SECRET]: ramp(32) },
    });
    await pick("FLASH32@SOIC8");
    click("Open…");
    await screen.findByRole("grid", { name: "Buffer bytes" });
    expectNoPaths();

    show(false);
    expect(
      within(screen.getByRole("log")).getByText(`Opened ${SECRET}: 32 bytes.`),
    ).toBeInTheDocument();
    expect(screen.getByText("bios dump.bin")).toHaveAttribute("title", SECRET);

    show(true);
    expectNoPaths();
  });

  it("covers the strings a scan found, and shows them when it's turned off", async () => {
    const dump = new Uint8Array(128).fill(0xff);
    dump.set(new TextEncoder().encode("wifi_psk=hunter2-hunter2"), 0x10);
    dump.set(new TextEncoder().encode("/etc/config/wireless"), 0x40);
    const { show } = setupHidden({ files: { [SECRET]: dump } });
    click("Open…");
    await screen.findByRole("grid", { name: "Buffer bytes" });
    click("Inspect");
    const panel = await screen.findByRole("region", { name: "Contents" });
    expect(await within(panel).findByText(/^2 strings, covered while/)).toBeInTheDocument();
    expect(within(panel).queryByRole("table", { name: "Strings" })).toBeNull();
    expect(within(panel).queryByRole("searchbox")).toBeNull();
    expect(panel).not.toHaveTextContent("hunter2");
    expect(panel).not.toHaveTextContent("wireless");

    show(false);
    const table = within(panel).getByRole("table", { name: "Strings" });
    expect(within(table).getByText("wifi_psk=hunter2-hunter2")).toBeInTheDocument();
    // A path in the chip's own text is the chip's, and is shown as it is.
    expect(within(table).getByText("/etc/config/wireless")).toBeInTheDocument();

    show(true);
    expect(panel).not.toHaveTextContent("hunter2");
  });

  it("hides where part of the buffer was saved to", async () => {
    const dump = new Uint8Array(128).fill(0xff);
    dump.set([0x27, 0x05, 0x19, 0x56], 0);
    const { dialogs } = setupHidden({ files: { [SECRET]: dump } });
    click("Open…");
    await screen.findByRole("grid", { name: "Buffer bytes" });
    click("Inspect");
    const panel = await screen.findByRole("region", { name: "Contents" });
    dialogs.save.mockResolvedValue("/home/me/customers/Jane Doe/header.bin");
    fireEvent.click(await within(panel).findByRole("button", { name: /^Save the uimage/ }));
    expect(
      await within(screen.getByRole("log")).findByText(
        "Saved 64 bytes from 0x00000000 (uimage) to [hidden].bin.",
      ),
    ).toBeInTheDocument();
    expectNoPaths();
  });

  it("leaves the chip search as typed", async () => {
    setupHidden();
    click(/^Detect/);
    await screen.findByText(/firmware 01\.1\.32$/);
    fireEvent.change(search(), { target: { value: "/odd" } });
    expect(search()).toHaveValue("/odd");
  });

  it("keeps the hex editor's edits across a redraw", async () => {
    const { controller } = setupHidden({
      socket: { chip: "FLASH32@SOIC8", memory: ramp(32) },
      files: { [SECRET]: ramp(32) },
    });
    await pick("FLASH32@SOIC8");
    click("Open…");
    const grid = await screen.findByRole("grid", { name: "Buffer bytes" });
    // A log line redraws the screen from a fresh masked copy; the editor
    // must be handed the very same bytes, or it would start over.
    click("Verify");
    await outcome("Verify passed");
    expect(screen.getByRole("grid", { name: "Buffer bytes" })).toBe(grid);
    expect(controller.getState().buffer?.original).toBeInstanceOf(Uint8Array);
  });
});
