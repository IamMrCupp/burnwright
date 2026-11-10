import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DeviceInfo } from "../../lib/engine";
import { DeviceNotices } from "./DeviceNotices";

const t48: DeviceInfo = {
  programmer: "T48",
  firmware: "00.1.03",
  chip: null,
  firmware_status: null,
  firmware_expected: null,
  support_warning: null,
};

describe("DeviceNotices", () => {
  it("renders nothing when minipro had no warnings", () => {
    const { container } = render(<DeviceNotices device={t48} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("announces out-of-date firmware as a warning", () => {
    render(
      <DeviceNotices
        device={{
          ...t48,
          firmware_status: "out_of_date",
          firmware_expected: "01.1.32",
          support_warning: "T48 support is not yet complete!",
        }}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Warning");
    expect(alert).toHaveTextContent("Firmware is out of date");
    expect(alert).toHaveTextContent("minipro expects 01.1.32");
    // The support note is there too, but it isn't an alert.
    expect(
      screen.getByRole("heading", { name: /T48 support is not yet complete/ }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("shows newer firmware as a note", () => {
    render(
      <DeviceNotices
        device={{
          ...t48,
          firmware: "00.1.35",
          firmware_status: "newer_than_expected",
          firmware_expected: "01.1.32",
        }}
      />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("heading", {
        name: /Note\s+Firmware is newer than minipro expects/,
      }),
    ).toBeInTheDocument();
  });
});
