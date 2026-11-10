import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Diagnosis } from "../../lib/engine";

const { detect, diagnoseProgrammer } = vi.hoisted(() => ({
  detect: vi.fn(),
  diagnoseProgrammer: vi.fn(),
}));

vi.mock("../../lib/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/engine")>();
  return {
    ...actual,
    engine: { ...actual.engine, detect, diagnoseProgrammer },
  };
});

import { DetectPanel } from "./DetectPanel";

const noProgrammer = {
  kind: "no_programmer",
  message: "no programmer detected",
  device_state: null,
};

const rulesMissing: Diagnosis = {
  os: "linux",
  probe_error: null,
  programmers: [
    {
      models: "TL866II+ / T48 / T56",
      usb_id: "a466:0a53",
      location: "1-1",
      state: {
        kind: "udev_rules_missing",
        node: "/dev/bus/usb/001/005",
        appimage: true,
        install_command: "sudo tee /etc/udev/rules.d/60-burnwright-minipro.rules",
      },
    },
  ],
};

const clickDetect = () =>
  fireEvent.click(screen.getByRole("button", { name: "Detect device" }));

beforeEach(() => {
  detect.mockReset();
  diagnoseProgrammer.mockReset();
});

describe("DetectPanel", () => {
  it("shows the device when detect works", async () => {
    detect.mockResolvedValueOnce({
      programmer: "T48",
      firmware: "01.1.32",
      chip: null,
      firmware_status: null,
      firmware_expected: null,
      support_warning: null,
    });
    render(<DetectPanel />);
    clickDetect();
    expect(await screen.findByText("Device detected")).toBeInTheDocument();
    expect(screen.getByText(/"programmer": "T48"/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(diagnoseProgrammer).not.toHaveBeenCalled();
  });

  it("warns about out-of-date firmware after a detect", async () => {
    detect.mockResolvedValueOnce({
      programmer: "T48",
      firmware: "00.1.03",
      chip: null,
      firmware_status: "out_of_date",
      firmware_expected: "01.1.32",
      support_warning: "T48 support is not yet complete!",
    });
    render(<DetectPanel />);
    clickDetect();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Firmware is out of date");
    expect(alert).toHaveTextContent(
      "This T48 runs firmware 00.1.03, and minipro expects 01.1.32.",
    );
    expect(
      screen.getByRole("heading", { name: /T48 support is not yet complete/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Device detected");
  });

  it("clears the firmware warning when detecting again", async () => {
    detect.mockResolvedValueOnce({
      programmer: "T48",
      firmware: "00.1.03",
      chip: null,
      firmware_status: "out_of_date",
      firmware_expected: "01.1.32",
      support_warning: null,
    });
    render(<DetectPanel />);
    clickDetect();
    await screen.findByRole("alert");
    detect.mockReturnValueOnce(new Promise(() => {}));
    clickDetect();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("diagnoses a missing programmer and shows the fix", async () => {
    detect.mockRejectedValueOnce(noProgrammer);
    diagnoseProgrammer.mockResolvedValueOnce(rulesMissing);
    render(<DetectPanel />);
    clickDetect();
    expect(
      await screen.findByRole("heading", {
        name: "No permission to use the programmer",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "No programmer found",
    );
    expect(screen.getByText(/60-burnwright-minipro\.rules/)).toBeInTheDocument();
    expect(diagnoseProgrammer).toHaveBeenCalledTimes(1);
  });

  it("doesn't diagnose other failures", async () => {
    detect.mockRejectedValueOnce({
      kind: "minipro_not_found",
      message: "minipro isn't installed",
      device_state: null,
    });
    render(<DetectPanel />);
    clickDetect();
    expect(
      await screen.findByText("Detect failed: minipro isn't installed"),
    ).toBeInTheDocument();
    expect(diagnoseProgrammer).not.toHaveBeenCalled();
  });

  it("still reports no programmer if the diagnosis call fails", async () => {
    detect.mockRejectedValueOnce(noProgrammer);
    diagnoseProgrammer.mockRejectedValueOnce(new Error("ipc down"));
    render(<DetectPanel />);
    clickDetect();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        /^No programmer found$/,
      ),
    );
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("clears the last diagnosis when detecting again", async () => {
    detect.mockRejectedValueOnce(noProgrammer);
    diagnoseProgrammer.mockResolvedValueOnce(rulesMissing);
    render(<DetectPanel />);
    clickDetect();
    await screen.findByRole("heading");
    detect.mockReturnValueOnce(new Promise(() => {}));
    clickDetect();
    expect(screen.queryByRole("heading")).toBeNull();
  });
});
