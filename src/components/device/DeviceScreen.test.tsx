import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import {
  createFakeEngine,
  fakeChip,
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
