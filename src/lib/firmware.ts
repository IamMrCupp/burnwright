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

function firmwareNotice(device: DeviceInfo): DeviceNotice | null {
  if (device.firmware_status === null) return null;
  const { programmer } = device;
  const runs = device.firmware ? `runs firmware ${device.firmware}` : null;
  const expected = device.firmware_expected;

  if (device.firmware_status === "out_of_date") {
    const versions =
      runs && expected
        ? `This ${programmer} ${runs}, and minipro expects ${expected}.`
        : `This ${programmer}'s firmware is older than minipro expects.`;
    return {
      severity: "warning",
      title: "Firmware is out of date",
      detail: `${versions} Reads and writes may fail or misbehave until it's updated. Updating takes XGecu's firmware file from the Xgpro package, flashed with Xgpro or minipro. burnwright doesn't ship or download that file, and doesn't flash firmware.`,
    };
  }

  const versions =
    runs && expected
      ? `This ${programmer} ${runs}, and this minipro was written for ${expected}.`
      : `This ${programmer}'s firmware is newer than this minipro was written for.`;
  return {
    severity: "info",
    title: "Firmware is newer than minipro expects",
    detail: `${versions} Nothing to fix. If something misbehaves, try a newer burnwright: it carries a newer minipro.`,
  };
}
