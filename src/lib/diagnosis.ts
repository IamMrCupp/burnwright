// Turns a `Diagnosis` from `engine.diagnoseProgrammer()` into what the UI
// says: one short explanation per programmer found, each with the fix and,
// where there is one, a command to copy.
import type { Diagnosis, ProgrammerReport, ProgrammerState } from "./engine";

/** One thing to tell the user. */
export interface Explanation {
  /** Short headline. */
  title: string;
  /** What's wrong and how to fix it. */
  detail: string;
  /** A shell command to copy and run, when the fix is one. */
  command: string | null;
  /** Which programmer this is about, e.g. "TL866II+ / T48 / T56 (a466:0a53)". */
  programmer: string | null;
}

/** The TL866A/CS: its own Windows driver isn't WinUSB, so switching costs the MiniPro app. */
const TL866A_ID = "04d8:e11c";

/** Windows problem codes worth naming. */
const PROBLEM_CODES: Record<number, string> = {
  10: "the device failed to start",
  22: "the device is disabled in Device Manager",
  24: "the device isn't fully present",
  31: "the driver failed to load",
  43: "the device reported a fault",
  45: "the device isn't connected right now",
};

/** Everything worth saying about `diagnosis`, most useful first. */
export function explainDiagnosis(diagnosis: Diagnosis): Explanation[] {
  if (diagnosis.programmers.length === 0) return [explainNothing(diagnosis)];
  return diagnosis.programmers.map((report) => ({
    ...explainState(report, diagnosis),
    programmer: `${report.models} (${report.usb_id})`,
  }));
}

function explainNothing(diagnosis: Diagnosis): Explanation {
  const checks =
    "Check the cable (some are charge-only), try another USB port, and make sure the programmer's power LED is on.";
  if (diagnosis.probe_error !== null) {
    return {
      title: "No programmer found",
      detail: `burnwright couldn't look at the USB devices itself (${diagnosis.probe_error}). ${checks}`,
      command: null,
      programmer: null,
    };
  }
  if (diagnosis.os === "other") {
    return {
      title: "No programmer found",
      detail: `burnwright can't list USB devices on this OS, so it can't say more. ${checks}`,
      command: null,
      programmer: null,
    };
  }
  return {
    title: "No programmer plugged in",
    detail: `Nothing on USB looks like a TL866 or T-series programmer. ${checks}`,
    command: null,
    programmer: null,
  };
}

function explainState(
  report: ProgrammerReport,
  diagnosis: Diagnosis,
): Omit<Explanation, "programmer"> {
  const state: ProgrammerState = report.state;
  switch (state.kind) {
    case "ready":
      return explainReady(state.driver, state.xgpro_compatible, diagnosis);
    case "unsupported_model":
      return {
        title: `The ${report.models} isn't supported yet`,
        detail:
          "The bundled minipro doesn't know this programmer. It needs a newer minipro release.",
        command: null,
      };
    case "udev_rules_missing":
      return {
        title: "No permission to use the programmer",
        detail: state.appimage
          ? `Linux needs a udev rule before you can open ${state.node} without root. The .deb package installs one, but an AppImage can't, so run this once:`
          : `Linux needs a udev rule before you can open ${state.node} without root. The .deb package installs one; for any other install, run this once:`,
        command: state.install_command,
      };
    case "not_in_group":
      return {
        title: `You're not in the ${state.group} group`,
        detail: `${state.node} belongs to the ${state.group} group. Add yourself, then log out and back in:`,
        command: state.command,
      };
    case "udev_rules_not_applied":
      return {
        title: "The udev rules haven't applied yet",
        detail: `minipro rules are installed (${state.rules_files.join(", ")}), but ${state.node} still isn't yours to open. Unplug the programmer and plug it back in, or reload the rules:`,
        command: state.reload_command,
      };
    case "node_unavailable":
      return {
        title: "Can't open the programmer's device node",
        detail: `${state.node}: ${state.error}. Unplug the programmer and plug it back in. In a container or sandbox, /dev/bus/usb has to be passed through.`,
        command: null,
      };
    case "no_driver":
      return {
        title: "No USB driver for the programmer",
        detail:
          report.usb_id === TL866A_ID
            ? "Windows sees the programmer but has no driver for it. Bind WinUSB to it with Zadig, then unplug it and plug it back in. The MiniPro app's own driver won't work with burnwright."
            : "Windows sees the programmer but has no driver for it. Installing Xgpro adds a WinUSB driver burnwright can use too; Zadig with WinUSB works as well. Then unplug it and plug it back in.",
        command: null,
      };
    case "wrong_driver":
      return state.reason === "libusbk_dll_missing"
        ? {
            title: `The ${state.service} driver needs libusbK.dll`,
            detail: `The programmer is bound to ${state.service}, which libusb only reaches through libusbK.dll, and that isn't installed. Switch the device to WinUSB in Zadig instead.`,
            command: null,
          }
        : {
            title: "The programmer has a driver minipro can't use",
            detail: `It's bound to ${state.service}${state.provider ? ` from ${state.provider}` : ""}. burnwright needs WinUSB. Zadig can switch it, but the vendor's own software won't see the programmer until you roll the driver back in Device Manager.`,
            command: null,
          };
    case "device_problem": {
      const meaning = PROBLEM_CODES[state.code];
      return {
        title: `Windows reports a problem with the programmer (Code ${state.code})`,
        detail: `${meaning ? `Device Manager says ${meaning}. ` : ""}Unplug it and plug it back in. If the code stays, reinstall its driver from Device Manager.`,
        command: null,
      };
    }
  }
}

function explainReady(
  driver: string | null,
  xgproCompatible: boolean | null,
  diagnosis: Diagnosis,
): Omit<Explanation, "programmer"> {
  if (diagnosis.os === "windows") {
    const hidden =
      xgproCompatible === false
        ? " This driver hides the programmer from Xgpro, which is fine for burnwright."
        : "";
    return {
      title: "The programmer is busy",
      detail: `The ${driver ?? "WinUSB"} driver is bound, and only one program can hold the programmer at a time. Close Xgpro or any other minipro, then detect again.${hidden}`,
      command: null,
    };
  }
  return {
    title: "The programmer is busy",
    detail:
      "It's plugged in and you can open it, so another program probably has it: close any other minipro, then detect again. If you just plugged it in, give it a second.",
    command: null,
  };
}
