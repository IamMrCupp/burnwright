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
  const until = `Until there is one, every read, write, erase and chip check on this ${programmer} will fail before it reaches the chip.`;
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
