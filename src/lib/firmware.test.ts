import { describe, expect, it } from "vitest";
import type { DeviceInfo } from "./engine";
import { deviceNotices } from "./firmware";

const t48: DeviceInfo = {
  programmer: "T48",
  firmware: "01.1.32",
  chip: null,
  firmware_status: null,
  firmware_expected: null,
  support_warning: null,
};

describe("deviceNotices", () => {
  it("says nothing about a programmer minipro is happy with", () => {
    expect(deviceNotices(t48)).toEqual([]);
  });

  it("warns about out-of-date firmware, with both versions and what updating takes", () => {
    const [notice, ...rest] = deviceNotices({
      ...t48,
      firmware: "00.1.03",
      firmware_status: "out_of_date",
      firmware_expected: "01.1.32",
    });
    expect(rest).toEqual([]);
    expect(notice.severity).toBe("warning");
    expect(notice.title).toBe("Firmware is out of date");
    expect(notice.detail).toContain(
      "This T48 runs firmware 1.03, and minipro expects 1.32. minipro prints these as 00.1.03 and 01.1.32: the first number isn't part of the firmware version.",
    );
    expect(notice.detail).toMatch(/Reads and writes may fail or misbehave/);
    expect(notice.detail).toMatch(/XGecu's firmware file/);
    expect(notice.detail).toMatch(/doesn't ship or download/);
  });

  it("treats newer firmware as a note, not a warning", () => {
    const [notice] = deviceNotices({
      ...t48,
      firmware: "00.1.35",
      firmware_status: "newer_than_expected",
      firmware_expected: "01.1.32",
    });
    expect(notice.severity).toBe("info");
    expect(notice.title).toBe("Firmware is newer than minipro expects");
    // "00.1.35" beside "01.1.32" reads as older. It's 1.35 against 1.32.
    expect(notice.detail).toBe(
      "This T48 runs firmware 1.35, and this minipro was written for 1.32. minipro prints these as 00.1.35 and 01.1.32: the first number isn't part of the firmware version. Nothing to fix. If something misbehaves, try a newer burnwright: it carries a newer minipro.",
    );
  });

  it("quotes the versions whole when they agree on the first number", () => {
    const [newer] = deviceNotices({
      ...t48,
      programmer: "TL866II+",
      firmware: "04.2.133",
      firmware_status: "newer_than_expected",
      firmware_expected: "04.2.132",
    });
    expect(newer.detail).toContain(
      "This TL866II+ runs firmware 04.2.133, and this minipro was written for 04.2.132. Nothing to fix.",
    );
    const [outdated] = deviceNotices({
      ...t48,
      programmer: "T76",
      firmware: "00.1.07",
      firmware_status: "out_of_date",
      firmware_expected: "00.1.17",
    });
    expect(outdated.detail).toContain(
      "This T76 runs firmware 00.1.07, and minipro expects 00.1.17. Reads and writes",
    );
  });

  it("quotes a version it can't take apart as it is", () => {
    const [notice] = deviceNotices({
      ...t48,
      firmware: "1.35-beta",
      firmware_status: "newer_than_expected",
      firmware_expected: "01.1.32",
    });
    expect(notice.detail).toContain(
      "This T48 runs firmware 1.35-beta, and this minipro was written for 01.1.32. Nothing to fix.",
    );
  });

  it("still reads when minipro left out a version", () => {
    const [outdated] = deviceNotices({
      ...t48,
      firmware_status: "out_of_date",
      firmware_expected: null,
    });
    expect(outdated.detail).toMatch(
      /^This T48's firmware is older than minipro expects\./,
    );
    const [newer] = deviceNotices({
      ...t48,
      firmware: null,
      firmware_status: "newer_than_expected",
      firmware_expected: "01.1.32",
    });
    expect(newer.detail).toMatch(/^This T48's firmware is newer than/);
  });

  it("passes on minipro's support note without the shout", () => {
    const [notice] = deviceNotices({
      ...t48,
      support_warning: "T48 support is not yet complete!",
    });
    expect(notice.severity).toBe("info");
    expect(notice.title).toBe("T48 support is not yet complete");
    expect(notice.detail).toMatch(/minipro's own note/);
  });

  it("puts the firmware warning ahead of the support note", () => {
    const notices = deviceNotices({
      programmer: "T76",
      firmware: "00.1.07",
      chip: null,
      firmware_status: "out_of_date",
      firmware_expected: "00.1.17",
      support_warning: "T76 support is experimental!",
    });
    expect(notices.map((n) => n.title)).toEqual([
      "Firmware is out of date",
      "T76 support is experimental",
    ]);
  });
});
