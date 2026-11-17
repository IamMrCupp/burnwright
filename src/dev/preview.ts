// What `pnpm dev` uses when the page is opened in a plain browser instead
// of the Tauri window: the fake engine, so the screen can be looked at and
// clicked through with no programmer and no Rust build. `main.tsx` only
// imports this in development.
//
// The chip in the pretend socket is a W25Q32BV@SOIC8 holding a pattern.
// Picking MX25L3206E@SOP8 gives a chip ID mismatch; "Open…" loads an image
// that's a few bytes different from the chip, so Verify shows a diff.
//
// `?programmer=none` starts with nothing plugged in, `?programmer=t76` or
// `tl866ii` with another model, and `?firmware=old` with out-of-date
// firmware.
import type { DeviceDeps } from "../lib/device/controller";
import { recentStore } from "../lib/device/recent";
import type { AppInfo, DeviceInfo } from "../lib/engine";
import { createFakeEngine } from "./fakeEngine";

const SIZE = 4 * 1024 * 1024;

function pattern(): Uint8Array {
  const bytes = new Uint8Array(SIZE);
  const text = new TextEncoder().encode("burnwright preview image. ");
  for (let i = 0; i < SIZE; i++) {
    bytes[i] = i < 4096 ? text[i % text.length] : (i * 31 + (i >> 8)) & 0xff;
  }
  bytes.fill(0xff, SIZE - 65536);
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

export function previewSetup(): {
  deps: DeviceDeps;
  loadAppInfo: () => Promise<AppInfo>;
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
      },
      recent: recentStore(window.localStorage),
    },
    loadAppInfo: async () => ({
      version: "preview",
      minipro: "fake",
      minipro_t76: "fake",
    }),
  };
}
