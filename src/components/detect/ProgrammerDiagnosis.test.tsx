import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Diagnosis } from "../../lib/engine";

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn() }));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import { ProgrammerDiagnosis } from "./ProgrammerDiagnosis";

const command = "sudo usermod -aG plugdev \"$USER\"";

const notInGroup: Diagnosis = {
  os: "linux",
  probe_error: null,
  programmers: [
    {
      models: "TL866II+ / T48 / T56",
      usb_id: "a466:0a53",
      location: "1-1",
      state: {
        kind: "not_in_group",
        node: "/dev/bus/usb/001/005",
        group: "plugdev",
        command,
      },
    },
  ],
};

const t76OnUsb3: Diagnosis = {
  os: "macos",
  probe_error: null,
  programmers: [
    {
      models: "T76",
      usb_id: "a466:1a86",
      location: "0x00224000",
      state: {
        kind: "usb3_link",
        link_speed_bps: 5_000_000_000,
        model_supported: true,
      },
    },
  ],
};

const ISSUE_50 = "https://github.com/IamMrCupp/burnwright/issues/50";

function mockClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
  openUrl.mockReset();
});

describe("ProgrammerDiagnosis", () => {
  it("shows the explanation, the programmer and the command", () => {
    render(<ProgrammerDiagnosis diagnosis={notInGroup} />);
    expect(
      screen.getByRole("heading", { name: "You're not in the plugdev group" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("TL866II+ / T48 / T56 (a466:0a53)"),
    ).toBeInTheDocument();
    expect(screen.getByText(command)).toBeInTheDocument();
  });

  it("copies the command", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);
    render(<ProgrammerDiagnosis diagnosis={notInGroup} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    expect(
      await screen.findByRole("button", { name: "Copied" }),
    ).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(command);
  });

  it("says so when copying fails", async () => {
    mockClipboard(() => Promise.reject(new Error("denied")));
    render(<ProgrammerDiagnosis diagnosis={notInGroup} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Couldn't copy",
    );
  });

  it("explains a T76 stuck on USB 3 and gives the fix", () => {
    render(<ProgrammerDiagnosis diagnosis={t76OnUsb3} />);
    expect(
      screen.getByRole("heading", { name: "The T76 is on a USB 3 link" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/USB 2\.0 hub or with a USB 2\.0-only cable/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", ISSUE_50);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("opens the background link in the system browser", async () => {
    openUrl.mockResolvedValue(undefined);
    render(<ProgrammerDiagnosis diagnosis={t76OnUsb3} />);
    fireEvent.click(screen.getByRole("link"));
    expect(openUrl).toHaveBeenCalledWith(ISSUE_50);
    await Promise.resolve();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the address when the link won't open", async () => {
    openUrl.mockRejectedValue(new Error("no opener"));
    render(<ProgrammerDiagnosis diagnosis={t76OnUsb3} />);
    fireEvent.click(screen.getByRole("link"));
    expect(await screen.findByRole("status")).toHaveTextContent(ISSUE_50);
  });

  it("has no link without one to give", () => {
    render(<ProgrammerDiagnosis diagnosis={notInGroup} />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("has no copy button without a command", () => {
    render(
      <ProgrammerDiagnosis
        diagnosis={{ os: "macos", programmers: [], probe_error: null }}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "No programmer plugged in" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
