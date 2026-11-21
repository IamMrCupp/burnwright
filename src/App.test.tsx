import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import App from "./App";
import { createFakeBench } from "./dev/fakeBench";
import { createFakeEngine } from "./dev/fakeEngine";
import { DeviceController } from "./lib/device/controller";
import { EcController } from "./lib/ec/controller";

function setup() {
  const dialogs = {
    open: async () => null,
    save: async () => null,
    openAlgorithms: async () => null,
  };
  const controller = new DeviceController({ engine: createFakeEngine(), dialogs });
  const bench = createFakeBench();
  const ec = new EcController({ bench });
  render(
    <App
      controller={controller}
      ec={ec}
      loadAppInfo={async () => ({ version: "1.2.3", minipro: "0.7.4", minipro_t76: "0.7.4+abc" })}
    />,
  );
  return { bench };
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
});
