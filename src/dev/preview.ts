// What `pnpm dev` uses when the page is opened in a plain browser instead
// of the Tauri window: the fake engine, so the screen can be looked at and
// clicked through with no programmer and no Rust build. `main.tsx` only
// imports this in development.
//
// The chip in the pretend socket is a W25Q32BV@SOIC8 holding a pattern,
// with the first bytes of a uImage, a gzip stream and a SquashFS planted in
// it: "Inspect" runs a pretend scan that finds those three by their first
// bytes and nothing else (`fakeScan`). The real scanner isn't in a browser.
// The entropy strip and the strings list are worked out from the bytes the
// way the scanner does it, so the image also holds what a router's flash
// would: a boot banner, boot arguments, a UTF-16 string, a stretch of log.
// Picking MX25L3206E@SOP8 gives a chip ID mismatch; "Open…" loads an image
// that's a few bytes different from the chip, so Verify shows a diff.
//
// `?programmer=none` starts with nothing plugged in, `?programmer=t76` or
// `tl866ii` with another model, and `?firmware=old` with out-of-date
// firmware. The pretend T76 has no algorithm file until one is chosen
// ("Choose file…" picks a pretend one; `?algorithms=installed` starts with
// one where minipro looks).
//
// The Laptop EC bench has a pretend flashrom, CH341A and KB9012.
// `?flashrom=missing` starts without flashrom ("Choose flashrom…" picks a
// pretend one), `?ch341a=none` with no programmer, `?ch341a=denied` with one
// plugged into a Linux machine that has no udev rule for it, and `?ec=silent`,
// `?ec=other` or `?ec=flaky` with a chip that doesn't answer, a different
// chip, or a loose wire whose two reads differ.
//
// The stream page has no server in a browser: turning it on shows the
// address it would have. `?stream=taken` has the port in use instead.
import type { DeviceDeps } from "../lib/device/controller";
import type { EcDeps } from "../lib/ec/controller";
import { recentStore } from "../lib/device/recent";
import type { StreamBackend } from "../lib/stream/controller";
import { settingsStore } from "../lib/device/settings";
import type { AppInfo, DeviceInfo } from "../lib/engine";
import { createFakeBench, type FakeBenchOptions } from "./fakeBench";
import { createFakeEngine, FAKE_ALGORITHM_DEFAULT } from "./fakeEngine";

const SIZE = 4 * 1024 * 1024;

function pattern(): Uint8Array {
  const bytes = new Uint8Array(SIZE);
  const text = new TextEncoder().encode("burnwright preview image. ");
  for (let i = 0; i < SIZE; i++) {
    bytes[i] = i < 4096 ? text[i % text.length] : (i * 31 + (i >> 8)) & 0xff;
  }
  bytes.fill(0xff, SIZE - 65536);
  // Never written between the kernel and the file system, and a stretch of
  // text further in: the entropy strip gets a floor, a middle and a ceiling.
  bytes.fill(0xff, 0x140000, 0x180000);
  const ascii = (at: number, line: string) => bytes.set(new TextEncoder().encode(line), at);
  for (let at = 0x300000, n = 0; at < 0x320000; at += 48, n++) {
    ascii(at, `[${String(n).padStart(8, " ")}.000000] preview: log line ${n}`.padEnd(47, ".") + "\n");
  }
  // The strings worth finding in it, a zero byte either side of each.
  const planted: [number, string][] = [
    [0x8000, "U-Boot 2019.07 (Jan 01 2020 - 00:00:00 +0000)\0"],
    [0x8040, "bootargs=console=ttyS0,115200 root=/dev/mtdblock2 rootfstype=squashfs\0"],
    [0x80a0, "bootcmd=bootm 0x9f010000\0"],
    [0x10020, "Linux-5.4.171\0"],
    [0x2f0000, "wifi_ssid=preview-network\0"],
    [0x2f0020, "wifi_psk=not-a-real-password\0"],
    [0x2f0040, "admin_user=admin\0"],
    [0x2f0060, "http://192.168.1.1/cgi-bin/luci\0"],
  ];
  for (const [at, line] of planted) ascii(at - 1, `\0${line}`);
  // What Windows and UEFI write: two bytes a character.
  const wide = "Preview Setup Utility";
  bytes.set([0, 0], 0x2f00fe);
  for (let i = 0; i <= wide.length; i++) bytes.set([wide.charCodeAt(i) || 0, 0], 0x2f0100 + i * 2);
  // What a router's flash starts like, as far as the pretend scan looks:
  // a boot image, a compressed kernel, a file system.
  bytes.set([0x27, 0x05, 0x19, 0x56], 0x10000);
  bytes.set([0x1f, 0x8b, 0x08, 0x00], 0x10040);
  bytes.set([0x68, 0x73, 0x71, 0x73], 0x180000);
  return bytes;
}

function programmer(params: URLSearchParams): DeviceInfo | null {
  const model = params.get("programmer");
  if (model === "none") return null;
  const old = params.get("firmware") === "old";
  const names: Record<string, string> = { t76: "T76", tl866ii: "TL866II+", t56: "T56" };
  const name = (model && names[model]) || "T48";
  return {
    programmer: name,
    firmware: old ? "00.1.03" : "01.1.32",
    chip: null,
    firmware_status: old ? "out_of_date" : null,
    firmware_expected: old ? "01.1.32" : null,
    support_warning: name === "T48" ? "T48 support is not yet complete!" : null,
  };
}

function ecDeps(params: URLSearchParams): EcDeps {
  const chips: FakeBenchOptions["chip"][] = ["silent", "other", "flaky"];
  const chip = chips.find((c) => c === params.get("ec")) ?? "kb9012";
  return {
    bench: createFakeBench({
      flashrom: params.get("flashrom") === "missing" ? null : undefined,
      otherFlashroms: ["/preview/bin/flashrom"],
      programmer: params.get("ch341a") !== "none",
      access: params.get("ch341a") === "denied" ? "no_udev_rule" : "ok",
      chip,
      stepMs: 150,
      steps: 12,
    }),
    chooseFlashrom: async () => "/preview/bin/flashrom",
    reveal: async () => {},
  };
}

function streamBackend(params: URLSearchParams): StreamBackend {
  const taken = params.get("stream") === "taken";
  return {
    configure: async (enabled, port) => {
      if (!enabled) return { running: false, url: null, error: null };
      if (taken) {
        return {
          running: false,
          url: null,
          error: `Port ${port} is in use by something else. Pick another.`,
        };
      }
      return { running: true, url: `http://127.0.0.1:${port}/stream`, error: null };
    },
    publish: async () => {},
  };
}

export function previewSetup(): {
  deps: DeviceDeps;
  ecDeps: EcDeps;
  streamBackend: StreamBackend;
  loadAppInfo: () => Promise<AppInfo>;
  openNotices: () => Promise<void>;
} {
  const params = new URLSearchParams(window.location.search);
  const onChip = pattern();
  const file = pattern();
  file.set([0xde, 0xad, 0xbe, 0xef], 0x40);
  file[0x1234] ^= 0xff;
  const engine = createFakeEngine({
    programmer: programmer(params),
    socket: { chip: "W25Q32BV@SOIC8", memory: onChip },
    files: {
      "/preview/firmware.bin": file,
      "/preview/short.bin": file.slice(0, 1024),
    },
    stepMs: 120,
    steps: 20,
    algorithmFile: params.get("algorithms") === "installed" ? FAKE_ALGORITHM_DEFAULT : null,
    algorithmFiles: ["/preview/xgecu/algorithm.xml"],
  });
  let opens = 0;
  return {
    deps: {
      engine,
      dialogs: {
        // No file panel in a browser: alternate between a full-size image
        // and a short one.
        open: async () => (opens++ % 2 === 0 ? "/preview/firmware.bin" : "/preview/short.bin"),
        save: async (suggested) => `/preview/${suggested.split("/").pop()}`,
        openAlgorithms: async () => "/preview/xgecu/algorithm.xml",
      },
      recent: recentStore(window.localStorage),
      settings: settingsStore(window.localStorage),
    },
    ecDeps: ecDeps(params),
    streamBackend: streamBackend(params),
    loadAppInfo: async () => ({
      version: "preview",
      minipro: "fake",
      minipro_t76: "fake",
    }),
    // A browser has no installed copy to open: show the one in the repo.
    openNotices: async () => {
      window.open(
        "https://github.com/IamMrCupp/burnwright/blob/main/THIRD-PARTY-NOTICES.txt",
        "_blank",
        "noopener",
      );
    },
  };
}
