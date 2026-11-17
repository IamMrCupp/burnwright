import { describe, expect, it } from "vitest";
import type { ChipCheck, DeviceInfo } from "../engine";
import { checkOutcome, failureOutcome, isBlankId } from "./messages";
import { NO_OVERRIDES } from "./state";

const device: DeviceInfo = {
  programmer: "T48",
  firmware: "00.1.35",
  chip: "W25Q32BV",
  firmware_status: null,
  firmware_expected: null,
  support_warning: null,
};

const mismatch = (found: string, detected: string | null = null): ChipCheck => ({
  device,
  chip_id: { status: "mismatch", expected: "0xEF4016", found, detected },
  pins: null,
});

const idError = (found: string) => ({
  kind: "chip_id_mismatch",
  message: `chip ID mismatch: expected 0xEF4016, found ${found}`,
  device_state: null,
});

describe("a chip ID that is all ones or all zeros", () => {
  it("is told apart from a real ID", () => {
    for (const id of ["0xFFFFFF", "0xffff", "0xFF", "0x0000", "0x000000", " 0xFFFF "]) {
      expect(isBlankId(id), id).toBe(true);
    }
    for (const id of ["0xEF4016", "0xC22016", "0xFF00", "0x00FF", "0xFFFFFE", "FFFF", "0x"]) {
      expect(isBlankId(id), id).toBe(false);
    }
  });

  it("makes Check chip say there's probably no chip, not a wrong one", () => {
    // What a T48 with an empty socket answers for W25Q32BV.
    const outcome = checkOutcome("W25Q32BV", mismatch("0xFFFFFF"));
    expect(outcome.tone).toBe("error");
    expect(outcome.title).toBe("No chip answered");
    expect(outcome.details).toEqual([
      "W25Q32BV should answer with ID 0xEF4016. The socket answers 0xFFFFFF. That's what the socket reads with no chip in it, or with one that isn't making contact. Check that a chip is in, the right way round, with the lever down.",
    ]);
    expect(checkOutcome("W25Q32BV", mismatch("0x000000")).title).toBe("No chip answered");
  });

  it("leaves a real mismatch as it was", () => {
    const outcome = checkOutcome("W25Q32BV", mismatch("0xC22016", "MX25L3206E"));
    expect(outcome.title).toBe("Chip ID mismatch");
    expect(outcome.details).toEqual([
      "W25Q32BV should answer with ID 0xEF4016. The chip in the socket answers 0xC22016, which minipro knows as MX25L3206E.",
    ]);
  });

  it("keeps a failed pin test as the headline", () => {
    const outcome = checkOutcome("W25Q32BV", {
      ...mismatch("0xFFFFFF"),
      pins: { status: "bad_contact", pins: [3] },
    });
    expect(outcome.title).toBe("Bad pin contact");
  });

  it("makes a stopped operation say the same, and still offers to go on", () => {
    const outcome = failureOutcome("read", "W25Q32BV", idError("0xFFFFFF"), NO_OVERRIDES);
    expect(outcome.title).toBe("No chip answered");
    expect(outcome.details).toEqual([
      "Expected 0xEF4016, found 0xFFFFFF.",
      "That's what the socket reads with no chip in it, or with one that isn't making contact. Check that a chip is in, the right way round, with the lever down. Nothing was read.",
      "minipro can carry on without the ID check. That's at your own risk: the wrong settings can damage a chip.",
    ]);
    expect(outcome.retry?.label).toBe("Read anyway, ignoring the chip ID");
  });

  it("leaves a stopped operation on a real mismatch as it was", () => {
    const outcome = failureOutcome(
      "write",
      "W25Q32BV",
      idError("0xC22016 (MX25L3206E)"),
      NO_OVERRIDES,
    );
    expect(outcome.title).toBe("Chip ID mismatch");
    expect(outcome.details.slice(0, 2)).toEqual([
      "Expected 0xEF4016, found 0xC22016 (MX25L3206E).",
      "The chip in the socket doesn't answer as W25Q32BV: it may be a different part, or badly seated. Nothing was written.",
    ]);
  });
});
