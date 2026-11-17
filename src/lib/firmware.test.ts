import { describe, expect, it } from "vitest";
import type { AlgorithmFile, DeviceInfo } from "./engine";
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

  describe("a T76's algorithm file", () => {
    const t76: DeviceInfo = { ...t48, programmer: "T76", firmware: "00.1.17" };
    const none: AlgorithmFile = {
      configured: null,
      found: null,
      default_path: "/usr/local/share/minipro/algorithm.xml",
    };

    it("warns before the first operation when minipro will find none", () => {
      expect(deviceNotices(t76, none)).toEqual([
        {
          severity: "warning",
          title: "No algorithm file for the T76",
          detail:
            "The T76 needs XGecu's algorithm.xml, a file from the Xgpro package, before it can work on a chip. burnwright doesn't ship or download it, and minipro found none at /usr/local/share/minipro/algorithm.xml. Until there is one, every read, write, erase and chip check on this T76 will fail before anything is read or written. Choose your own copy below, or put it at that path.",
        },
      ]);
    });

    it("names a chosen file that isn't there any more", () => {
      const [notice] = deviceNotices(t76, { ...none, configured: "/home/me/algorithm.xml" });
      expect(notice.severity).toBe("warning");
      expect(notice.title).toBe("The chosen algorithm file isn't there");
      expect(notice.detail).toContain(
        "T76 operations are pointed at /home/me/algorithm.xml, and no file is there now.",
      );
      expect(notice.detail).toMatch(/Choose the file again below, or clear the choice/);
    });

    it("says nothing when there is a file, or when it can't tell", () => {
      const found = "/usr/local/share/minipro/algorithm.xml";
      expect(deviceNotices(t76, { ...none, found })).toEqual([]);
      expect(
        deviceNotices(t76, { configured: "/x/algorithm.xml", found: "/x/algorithm.xml", default_path: null }),
      ).toEqual([]);
      // A minipro burnwright didn't build: where it looks isn't known.
      expect(deviceNotices(t76, { configured: null, found: null, default_path: null })).toEqual([]);
      // The engine hasn't answered.
      expect(deviceNotices(t76, null)).toEqual([]);
      expect(deviceNotices(t76)).toEqual([]);
    });

    it("is only ever about a T76", () => {
      expect(deviceNotices(t48, none)).toEqual([]);
      expect(deviceNotices({ ...t48, programmer: "T56" }, none)).toEqual([]);
    });

    it("comes first: nothing works without it", () => {
      const notices = deviceNotices(
        {
          ...t76,
          firmware: "00.1.07",
          firmware_status: "out_of_date",
          firmware_expected: "00.1.17",
          support_warning: "T76 support is experimental!",
        },
        none,
      );
      expect(notices.map((n) => n.title)).toEqual([
        "No algorithm file for the T76",
        "Firmware is out of date",
        "T76 support is experimental",
      ]);
    });
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
