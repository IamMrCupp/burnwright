import { describe, expect, it } from "vitest";
import { explainDiagnosis } from "./diagnosis";
import type {
  Diagnosis,
  HostOs,
  ProgrammerReport,
  ProgrammerState,
} from "./engine";

const T48 = { models: "TL866II+ / T48 / T56", usb_id: "a466:0a53" };
const TL866A = { models: "TL866A / TL866CS", usb_id: "04d8:e11c" };

function diagnosis(
  os: HostOs,
  states: ProgrammerState[] = [],
  ids = T48,
): Diagnosis {
  const programmers: ProgrammerReport[] = states.map((state) => ({
    ...ids,
    location: "1-1",
    state,
  }));
  return { os, programmers, probe_error: null };
}

function only(d: Diagnosis) {
  const all = explainDiagnosis(d);
  expect(all).toHaveLength(1);
  return all[0];
}

const INSTALL = "sudo tee /etc/udev/rules.d/60-burnwright-minipro.rules";

describe("explainDiagnosis: nothing found", () => {
  it("says nothing is plugged in", () => {
    const e = only(diagnosis("linux"));
    expect(e.title).toBe("No programmer plugged in");
    expect(e.detail).toMatch(/cable/);
    expect(e.command).toBeNull();
    expect(e.programmer).toBeNull();
  });

  it("passes on a probe error", () => {
    const e = only({
      ...diagnosis("linux"),
      probe_error: "can't list /sys/bus/usb/devices",
    });
    expect(e.title).toBe("No programmer found");
    expect(e.detail).toContain("can't list /sys/bus/usb/devices");
  });

  it("admits it can't look on an unknown OS", () => {
    expect(only(diagnosis("other")).detail).toMatch(/can't list USB devices/);
  });
});

describe("explainDiagnosis: Linux", () => {
  const node = "/dev/bus/usb/001/005";

  it("gives the AppImage the install command", () => {
    const e = only(
      diagnosis("linux", [
        {
          kind: "udev_rules_missing",
          node,
          appimage: true,
          install_command: INSTALL,
        },
      ]),
    );
    expect(e.title).toBe("No permission to use the programmer");
    expect(e.detail).toContain("an AppImage can't");
    expect(e.detail).toContain(node);
    expect(e.command).toBe(INSTALL);
    expect(e.programmer).toBe("TL866II+ / T48 / T56 (a466:0a53)");
  });

  it("points other installs at the .deb or the command", () => {
    const e = only(
      diagnosis("linux", [
        {
          kind: "udev_rules_missing",
          node,
          appimage: false,
          install_command: INSTALL,
        },
      ]),
    );
    expect(e.detail).not.toContain("AppImage");
    expect(e.detail).toContain(".deb");
    expect(e.command).toBe(INSTALL);
  });

  it("says which group to join", () => {
    const e = only(
      diagnosis("linux", [
        {
          kind: "not_in_group",
          node,
          group: "plugdev",
          command: 'sudo usermod -aG plugdev "$USER"',
        },
      ]),
    );
    expect(e.title).toBe("You're not in the plugdev group");
    expect(e.detail).toMatch(/log out and back in/);
    expect(e.command).toBe('sudo usermod -aG plugdev "$USER"');
  });

  it("says replug or reload when rules exist", () => {
    const e = only(
      diagnosis("linux", [
        {
          kind: "udev_rules_not_applied",
          node,
          rules_files: ["/usr/lib/udev/rules.d/60-minipro.rules"],
          reload_command: "sudo udevadm control --reload-rules",
        },
      ]),
    );
    expect(e.detail).toContain("/usr/lib/udev/rules.d/60-minipro.rules");
    expect(e.detail).toMatch(/Unplug/);
    expect(e.command).toBe("sudo udevadm control --reload-rules");
  });

  it("reports a node that won't open", () => {
    const e = only(
      diagnosis("linux", [
        { kind: "node_unavailable", node, error: "No such device" },
      ]),
    );
    expect(e.detail).toContain(`${node}: No such device`);
    expect(e.command).toBeNull();
  });

  it("calls an accessible programmer busy", () => {
    const e = only(
      diagnosis("linux", [
        { kind: "ready", driver: null, xgpro_compatible: null },
      ]),
    );
    expect(e.title).toBe("The programmer is busy");
    expect(e.detail).not.toMatch(/Xgpro/);
  });
});

describe("explainDiagnosis: Windows", () => {
  it("tells WinUSB users to close Xgpro", () => {
    const e = only(
      diagnosis("windows", [
        { kind: "ready", driver: "WinUSB", xgpro_compatible: true },
      ]),
    );
    expect(e.title).toBe("The programmer is busy");
    expect(e.detail).toMatch(/Close Xgpro/);
    expect(e.detail).not.toMatch(/hides/);
  });

  it("notes a driver that hides the programmer from Xgpro", () => {
    const e = only(
      diagnosis("windows", [
        { kind: "ready", driver: "WinUSB", xgpro_compatible: false },
      ]),
    );
    expect(e.detail).toMatch(/hides the programmer from Xgpro/);
  });

  it("suggests Xgpro's driver when there's none", () => {
    const e = only(diagnosis("windows", [{ kind: "no_driver" }]));
    expect(e.title).toBe("No USB driver for the programmer");
    expect(e.detail).toMatch(/Installing Xgpro/);
  });

  it("warns TL866A/CS users off the MiniPro driver", () => {
    const e = only(diagnosis("windows", [{ kind: "no_driver" }], TL866A));
    expect(e.detail).toMatch(/Zadig/);
    expect(e.detail).toMatch(/MiniPro app's own driver won't work/);
  });

  it("names a driver minipro can't use", () => {
    const e = only(
      diagnosis("windows", [
        {
          kind: "wrong_driver",
          service: "XGMiniPro",
          provider: "XGecu",
          reason: "not_winusb",
        },
      ]),
    );
    expect(e.detail).toContain("bound to XGMiniPro from XGecu");
    expect(e.detail).toMatch(/WinUSB/);
  });

  it("explains a libusbK binding without the DLL", () => {
    const e = only(
      diagnosis("windows", [
        {
          kind: "wrong_driver",
          service: "libusbK",
          provider: null,
          reason: "libusbk_dll_missing",
        },
      ]),
    );
    expect(e.title).toBe("The libusbK driver needs libusbK.dll");
  });

  it("names known problem codes and survives unknown ones", () => {
    const disabled = only(
      diagnosis("windows", [
        { kind: "device_problem", code: 22, service: "WinUSB" },
      ]),
    );
    expect(disabled.title).toContain("Code 22");
    expect(disabled.detail).toMatch(/disabled in Device Manager/);
    const odd = only(
      diagnosis("windows", [{ kind: "device_problem", code: 99, service: null }]),
    );
    expect(odd.detail).toMatch(/^Unplug/);
  });
});

describe("explainDiagnosis: other cases", () => {
  it("says an unsupported model needs a newer minipro", () => {
    const e = only(
      diagnosis("macos", [{ kind: "unsupported_model" }], {
        models: "T76",
        usb_id: "a466:1a86",
      }),
    );
    expect(e.title).toBe("The T76 isn't supported yet");
  });

  it("explains each programmer found", () => {
    const all = explainDiagnosis(
      diagnosis("macos", [
        { kind: "ready", driver: null, xgpro_compatible: null },
        { kind: "unsupported_model" },
      ]),
    );
    expect(all).toHaveLength(2);
  });
});
