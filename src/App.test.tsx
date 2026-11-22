import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import App from "./App";
import { AppearanceController, appearanceStore, type AppearanceDeps } from "./lib/appearance";
import { createFakeBench } from "./dev/fakeBench";
import { createFakeEngine } from "./dev/fakeEngine";
import { DeviceController } from "./lib/device/controller";
import { EcController } from "./lib/ec/controller";
import { StreamController } from "./lib/stream/controller";

function setup() {
  const dialogs = {
    open: async () => null,
    save: async () => null,
    openAlgorithms: async () => null,
  };
  const controller = new DeviceController({ engine: createFakeEngine(), dialogs });
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
    />,
  );
  return { bench, configure };
}

const mode = (name: string) => screen.getByRole("button", { name });

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
