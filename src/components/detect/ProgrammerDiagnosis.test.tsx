import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Diagnosis } from "../../lib/engine";
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

function mockClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
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
