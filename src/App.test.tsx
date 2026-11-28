import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import App from "./App";
import { AppearanceController, appearanceStore, type AppearanceDeps } from "./lib/appearance";
import { createFakeBench } from "./dev/fakeBench";
import { createFakeEngine } from "./dev/fakeEngine";
import { DeviceController } from "./lib/device/controller";
import { EcController } from "./lib/ec/controller";
import { StreamController } from "./lib/stream/controller";

function setup(openNotices?: () => Promise<void>, files?: Record<string, Uint8Array>) {
  const dialogs = {
    open: vi.fn<() => Promise<string | null>>(async () => null),
    save: async () => null,
    openAlgorithms: async () => null,
  };
  const engine = createFakeEngine({ files });
  const controller = new DeviceController({ engine, dialogs });
  const bench = createFakeBench();
  const ec = new EcController({ bench });
  const appearance = new AppearanceController({
    store: appearanceStore(window.localStorage),
    root: document.documentElement,
    systemDark: {
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as AppearanceDeps["systemDark"],
  });
  const configure = vi.fn(async () => ({ running: false, url: null, error: null }));
  const stream = new StreamController({
    backend: { configure, publish: async () => {} },
    device: controller,
  });
  render(
    <App
      controller={controller}
      ec={ec}
      appearance={appearance}
      stream={stream}
      loadAppInfo={async () => ({ version: "1.2.3", minipro: "0.7.4", minipro_t76: "0.7.4+abc" })}
      openNotices={openNotices}
    />,
  );
  return { bench, configure, dialogs, engine };
}

const mode = (name: string) => screen.getByRole("button", { name });

describe("the licences button", () => {
  it("opens the notices this copy was installed with", async () => {
    const openNotices = vi.fn(async () => {});
    setup(openNotices);
    await screen.findByText(/burnwright v1\.2\.3/);
    fireEvent.click(screen.getByRole("button", { name: "Licences" }));
    expect(openNotices).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("is on both benches", async () => {
    setup(async () => {});
    expect(screen.getByRole("button", { name: "Licences" })).toBeInTheDocument();
    fireEvent.click(mode("Laptop EC"));
    expect(screen.getByRole("button", { name: "Licences" })).toBeInTheDocument();
  });

  it("says why when the file can't be opened, and clears that on the next try", async () => {
    const openNotices = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce("this copy of burnwright has no THIRD-PARTY-NOTICES.txt")
      .mockResolvedValue(undefined);
    setup(openNotices);
    fireEvent.click(screen.getByRole("button", { name: "Licences" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn\u2019t open the licences: this copy of burnwright has no THIRD-PARTY-NOTICES.txt",
    );
    fireEvent.click(screen.getByRole("button", { name: "Licences" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("isn't drawn where there's nothing to open", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Licences" })).toBeNull();
  });
});

describe("the bench switch", () => {
  it("starts on the programmer and leaves the EC's hardware alone", async () => {
    const { bench } = setup();
    expect(mode("Programmer")).toHaveAttribute("aria-pressed", "true");
    expect(mode("Laptop EC")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("region", { name: "Operations" })).toBeInTheDocument();
    await screen.findByText(/burnwright v1\.2\.3/);
    // flashrom isn't run for a screen nobody opened.
    expect(bench.calls).toEqual([]);
  });

  it("shows the EC bench, and comes back", async () => {
    const { bench } = setup();
    fireEvent.click(mode("Laptop EC"));
    expect(mode("Laptop EC")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("region", { name: "Wiring" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Operations" })).toBeNull();
    await screen.findByText("CH341A connected");
    expect(bench.calls).toEqual(["list_probes"]);
    await screen.findByText(/burnwright v1\.2\.3/);

    fireEvent.click(mode("Programmer"));
    expect(screen.getByRole("region", { name: "Operations" })).toBeInTheDocument();
    // Coming back to the EC bench doesn't look again by itself.
    fireEvent.click(mode("Laptop EC"));
    await screen.findByText("CH341A connected");
    expect(bench.calls).toEqual(["list_probes"]);
  });

  it("keeps an unsaved edit, its undo and the cursor across a trip to the EC bench", async () => {
    const { dialogs, engine } = setup(undefined, {
      "/image.bin": Uint8Array.from({ length: 64 }, (_, i) => i),
    });
    const cell = (index: number) =>
      document.querySelector<HTMLElement>(`.hv-byte[data-index="${index}"]`)!;
    dialogs.open.mockResolvedValue("/image.bin");
    fireEvent.click(screen.getByRole("button", { name: "Open…" }));
    const grid = await screen.findByRole("grid", { name: "Buffer bytes" });
    fireEvent.mouseDown(cell(5), { button: 0 });
    fireEvent.keyDown(grid, { key: "A" });
    fireEvent.keyDown(grid, { key: "B" });
    fireEvent.mouseDown(cell(9), { button: 0 });
    expect(screen.getByText("Edited, not saved")).toBeInTheDocument();

    fireEvent.click(mode("Laptop EC"));
    expect(screen.queryByRole("grid", { name: "Buffer bytes" })).toBeNull();
    fireEvent.click(mode("Programmer"));

    // The editor shows the edit, not the file's byte, and can still undo it.
    expect(cell(5)).toHaveTextContent("AB");
    expect(screen.getByText("1 byte edited")).toBeInTheDocument();
    expect(cell(9)).toHaveClass("hv-cursor");
    expect(screen.getByText("Edited, not saved")).toBeInTheDocument();
    // What's on screen is what gets saved.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(engine.saved["/image.bin"]?.[5]).toBe(0xab));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(cell(5)).toHaveTextContent("05");
    expect(screen.getByText("Unmodified")).toBeInTheDocument();
  });

  it("keeps the Appearance choice in reach on both benches", () => {
    setup();
    expect(screen.getByLabelText("Appearance")).toHaveValue("system");
    fireEvent.click(mode("Laptop EC"));
    expect(screen.getByLabelText("Appearance")).toHaveValue("system");
  });

  it("has the stream page's switch on both benches, off until it's turned on", () => {
    const { configure } = setup();
    expect(screen.getByRole("button", { name: "Stream page: off" })).toBeInTheDocument();
    fireEvent.click(mode("Laptop EC"));
    expect(screen.getByRole("button", { name: "Stream page: off" })).toBeInTheDocument();
    // Nothing is started for a page nobody asked for.
    expect(configure).not.toHaveBeenCalled();
  });

  it("hides paths on both benches from the one switch", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Stream page: off" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Hide file paths in this window" }));
    expect(screen.getByText("Paths hidden")).toBeInTheDocument();
    fireEvent.click(mode("Laptop EC"));
    expect(screen.getByText("Paths hidden")).toBeInTheDocument();
    // The fake flashrom lives at a path; with the switch on it isn't drawn.
    await screen.findByText("CH341A connected");
    expect(document.body.textContent).not.toMatch(/\/usr|\/opt|\/bin\//);
  });
});
