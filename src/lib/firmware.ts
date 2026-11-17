// Turns the warnings minipro prints about a detected programmer (carried on
// `DeviceInfo`) into what the UI says after a successful detect.
import type { DeviceInfo } from "./engine";

/** One thing to tell the user about the programmer that was found. */
export interface DeviceNotice {
  /** `warning`: worth acting on. `info`: good to know, nothing to do. */
  severity: "warning" | "info";
  /** Short headline. */
  title: string;
  /** What it means, and what to do about it if anything. */
  detail: string;
}

/** Everything worth saying about `device`, most important first. */
export function deviceNotices(device: DeviceInfo): DeviceNotice[] {
  const notices: DeviceNotice[] = [];
  const firmware = firmwareNotice(device);
  if (firmware) notices.push(firmware);
  if (device.support_warning) {
    notices.push({
      severity: "info",
      // "T48 support is not yet complete!" reads better without the shout.
      title: device.support_warning.replace(/[!.]+$/, ""),
      detail:
        "That's minipro's own note about this programmer: some chips or features may not work yet.",
    });
  }
  return notices;
}

/**
 * The two versions as they can be compared, and a note on how minipro
 * prints them when that differs.
 *
 * minipro prints a version as `HH.M.mm`, and only `M.mm` is the firmware.
 * `HH` in the version it found is a byte it reads from a TL866 and fills
 * with `00` for a T48 or T56; `HH` in the version it expects is part of a
 * fixed string. So a T48 on firmware 1.35 shows as "00.1.35" against an
 * expected "01.1.32", and side by side the newer one looks older. When the
 * two disagree on `HH`, the sentence compares `M.mm` and says what minipro
 * printed.
 */
function comparable(
  found: string,
  expected: string,
): { found: string; expected: string; printedAs: string } {
  const parts = (version: string) => /^(\d+)\.(\d+\.\d+)$/.exec(version.trim());
  const f = parts(found);
  const e = parts(expected);
  if (!f || !e || f[1] === e[1]) return { found, expected, printedAs: "" };
  return {
    found: f[2],
    expected: e[2],
    printedAs: ` minipro prints these as ${found} and ${expected}: the first number isn't part of the firmware version.`,
  };
}

function firmwareNotice(device: DeviceInfo): DeviceNotice | null {
  if (device.firmware_status === null) return null;
  const { programmer } = device;
  const both =
    device.firmware && device.firmware_expected
      ? comparable(device.firmware, device.firmware_expected)
      : null;

  if (device.firmware_status === "out_of_date") {
    const versions = both
      ? `This ${programmer} runs firmware ${both.found}, and minipro expects ${both.expected}.${both.printedAs}`
      : `This ${programmer}'s firmware is older than minipro expects.`;
    return {
      severity: "warning",
      title: "Firmware is out of date",
      detail: `${versions} Reads and writes may fail or misbehave until it's updated. Updating takes XGecu's firmware file from the Xgpro package, flashed with Xgpro or minipro. burnwright doesn't ship or download that file, and doesn't flash firmware.`,
    };
  }

  const versions = both
    ? `This ${programmer} runs firmware ${both.found}, and this minipro was written for ${both.expected}.${both.printedAs}`
    : `This ${programmer}'s firmware is newer than this minipro was written for.`;
  return {
    severity: "info",
    title: "Firmware is newer than minipro expects",
    detail: `${versions} Nothing to fix. If something misbehaves, try a newer burnwright: it carries a newer minipro.`,
  };
}
