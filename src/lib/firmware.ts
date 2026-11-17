// Turns the warnings minipro prints about a detected programmer (carried on
// `DeviceInfo`) into what the UI says after a successful detect, along with
// what burnwright can see for itself: a T76 with no algorithm file.
import {
  algorithmFileMissing,
  programmerFromModel,
  type AlgorithmFile,
  type DeviceInfo,
} from "./engine";

/** One thing to tell the user about the programmer that was found. */
export interface DeviceNotice {
  /** `warning`: worth acting on. `info`: good to know, nothing to do. */
  severity: "warning" | "info";
  /** Short headline. */
  title: string;
  /** What it means, and what to do about it if anything. */
  detail: string;
}

/**
 * Everything worth saying about `device`, most important first.
 * `algorithms` is where the T76's `algorithm.xml` stands, when the engine
 * has been asked; it's ignored for every other programmer.
 */
export function deviceNotices(
  device: DeviceInfo,
  algorithms: AlgorithmFile | null = null,
): DeviceNotice[] {
  const notices: DeviceNotice[] = [];
  const algorithm = algorithmNotice(device, algorithms);
  if (algorithm) notices.push(algorithm);
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
 * A T76 that minipro will find no `algorithm.xml` for: every chip operation
 * is going to fail, so say so before the first one does.
 */
function algorithmNotice(
  device: DeviceInfo,
  algorithms: AlgorithmFile | null,
): DeviceNotice | null {
  if (programmerFromModel(device.programmer) !== "t76") return null;
  if (!algorithms || !algorithmFileMissing(algorithms)) return null;
  const { programmer } = device;
  const until = `Until there is one, every read, write, erase and chip check on this ${programmer} will fail before anything is read or written.`;
  if (algorithms.configured !== null) {
    return {
      severity: "warning",
      title: "The chosen algorithm file isn't there",
      detail: `${programmer} operations are pointed at ${algorithms.configured}, and no file is there now. ${until} Choose the file again below, or clear the choice to go back to where minipro looks on its own.`,
    };
  }
  return {
    severity: "warning",
    title: `No algorithm file for the ${programmer}`,
    detail: `The ${programmer} needs XGecu's algorithm.xml, a file from the Xgpro package, before it can work on a chip. burnwright doesn't ship or download it, and minipro found none at ${algorithms.default_path}. ${until} Choose your own copy below, or put it at that path.`,
  };
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
