import { describe, expect, it } from "vitest";
import { regionFileName } from "./format";

describe("regionFileName", () => {
  it("names the image, the offset and what was found there", () => {
    expect(regionFileName("firmware.bin", 0x180000, "squashfs")).toBe(
      "firmware-0x180000-squashfs.bin",
    );
    expect(regionFileName("W25Q32BV@SOIC8", 0, "uimage")).toBe("W25Q32BV_SOIC8-0x0-uimage.bin");
  });

  it("takes the name from a path, for either separator", () => {
    expect(regionFileName("/home/me/dumps/router.bin", 0x10040, "gzip")).toBe(
      "router-0x10040-gzip.bin",
    );
    expect(regionFileName("C:\\dumps\\router.v2.hex", 0xabc, "lzma")).toBe(
      "router.v2-0xABC-lzma.bin",
    );
  });

  it("keeps out what a file name can't hold", () => {
    expect(regionFileName("bios dump (1).bin", 64, "uefi/pi firmware volume")).toBe(
      "bios_dump_1-0x40-uefi_pi_firmware_volume.bin",
    );
    expect(regionFileName("../../etc/passwd", 0, "../x")).toBe("passwd-0x0-x.bin");
  });

  it("still gives a name when there's nothing to go on", () => {
    expect(regionFileName("", 16, "")).toBe("image-0x10-region.bin");
    expect(regionFileName(".bin", 16, "///")).toBe("bin-0x10-region.bin");
  });
});
