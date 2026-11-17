// The device screen's words: how an operation ended, and what a
// confirmation asks. Pure functions, so the copy is tested without a DOM.
import {
  deviceMayBeInconsistent,
  errorMessage,
  isEngineError,
  type ChipCheck,
  type EngineErrorKind,
} from "../engine";
import { isSizeMismatch, type SizeCheck } from "./chip";
import { formatByteCount, joinList, sentence } from "./format";
import {
  OP_LABELS,
  type Confirm,
  type OpKind,
  type Outcome,
  type Overrides,
} from "./state";

/** What didn't happen, when minipro stopped before touching the chip. */
const NOT_DONE: Record<OpKind, string> = {
  read: "Nothing was read.",
  verify: "Nothing was verified.",
  blank_check: "The chip wasn't checked.",
  erase: "Nothing was erased.",
  write: "Nothing was written.",
  check: "The chip wasn't checked.",
};

/**
 * A rejection's message without the engine's "minipro error: " label: the
 * screen already says which operation failed.
 */
export function plainMessage(err: unknown): string {
  return errorMessage(err).replace(/^minipro error:\s*/i, "");
}

function errorKind(err: unknown): EngineErrorKind | "other" {
  return isEngineError(err) ? err.kind : "other";
}

/** A read that worked: `length` bytes are now the buffer. */
export function readOutcome(chip: string, length: number, expected: number | null): Outcome {
  const details = [`${formatByteCount(length)} from the chip are in the buffer.`];
  if (expected !== null && expected !== length) {
    details.push(
      `minipro's entry for ${chip} says ${formatByteCount(expected)}, so this read is not the size it expected.`,
    );
  }
  return {
    op: "read",
    chip,
    tone: expected !== null && expected !== length ? "warning" : "ok",
    title: `Read ${chip}`,
    details,
    retry: null,
  };
}

export function verifyOutcome(chip: string, overrides: Overrides): Outcome {
  return {
    op: "verify",
    chip,
    tone: "ok",
    title: "Verify passed",
    details: [
      overrides.ignoreSize
        ? `${chip} matches the buffer over the bytes both have. The size check was off, so the rest wasn't compared.`
        : `${chip} matches the buffer.`,
    ],
    retry: null,
  };
}

export function blankOutcome(chip: string, blank: boolean): Outcome {
  return blank
    ? {
        op: "blank_check",
        chip,
        tone: "ok",
        title: "Chip is blank",
        details: [`${chip} has nothing written to it.`],
        retry: null,
      }
    : {
        op: "blank_check",
        chip,
        tone: "warning",
        title: "Chip is not blank",
        details: [`${chip} has data on it.`],
        retry: null,
      };
}

export function eraseOutcome(chip: string): Outcome {
  return {
    op: "erase",
    chip,
    tone: "ok",
    title: `Erased ${chip}`,
    details: [],
    retry: null,
  };
}

export function writeOutcome(chip: string, length: number, overrides: Overrides): Outcome {
  const details = [
    `minipro wrote ${formatByteCount(length)} from the buffer and read the chip back to check them.`,
  ];
  if (overrides.ignoreSize) {
    details.push(
      "The size check was off: only the bytes the buffer and the chip both have were written and checked.",
    );
  }
  return {
    op: "write",
    chip,
    tone: "ok",
    title: `Wrote ${chip}`,
    details,
    retry: null,
  };
}

/** What the ID and pin-contact test found. */
export function checkOutcome(chip: string, check: ChipCheck): Outcome {
  const details: string[] = [];
  let tone: Outcome["tone"] = "ok";
  let title = "Chip check passed";

  const { pins, chip_id: id } = check;
  if (pins?.status === "bad_contact") {
    tone = "error";
    title = "Bad pin contact";
    const many = pins.pins.length !== 1;
    details.push(
      `Pin${many ? "s" : ""} ${joinList(pins.pins)} of the socket ${many ? "don't" : "doesn't"} make contact. Reseat the chip, check that it's the right way round, and check again.`,
    );
    if (!id) details.push("The chip ID wasn't read: minipro stops at a failed pin test.");
  } else if (pins?.status === "passed") {
    details.push("Every pin makes contact.");
  } else if (pins?.status === "unsupported") {
    details.push("Pin contact wasn't tested: this programmer can't run the test.");
  }

  if (id?.status === "match") {
    details.push(`The chip ID is ${id.id}, as ${chip} should have.`);
  } else if (id?.status === "mismatch") {
    tone = "error";
    if (pins?.status !== "bad_contact") title = "Chip ID mismatch";
    const guess = id.detected ? `, which minipro knows as ${id.detected}` : "";
    details.push(
      `${chip} should answer with ID ${id.expected}. The chip in the socket answers ${id.found}${guess}.`,
    );
  } else if (id?.status === "no_chip_id") {
    details.push(`${chip} has no ID to read, so minipro can't tell whether it's the chip in the socket.`);
    if (tone === "ok") title = "Nothing to check";
  }

  return { op: "check", chip, tone, title, details, retry: null };
}

/**
 * How a failed or cancelled operation is reported. `overrides` are the
 * checks that were already off for this run; a retry adds one more.
 */
export function failureOutcome(
  op: OpKind,
  chip: string,
  err: unknown,
  overrides: Overrides,
): Outcome {
  const label = OP_LABELS[op];
  const base = { op, chip, retry: null };
  const kind = errorKind(err);

  if (kind === "cancelled") {
    return deviceMayBeInconsistent(err)
      ? {
          ...base,
          tone: "error",
          title: `${label} cancelled`,
          details: [
            op === "erase"
              ? `${chip} may be half-erased. Erase it again before trusting what's on it.`
              : `${chip} may be half-programmed. Erase it or write it again before trusting what's on it.`,
          ],
        }
      : {
          ...base,
          tone: "warning",
          title: `${label} cancelled`,
          details: ["Nothing on the chip changed."],
        };
  }

  if (kind === "verify_failed") {
    return op === "write"
      ? {
          ...base,
          tone: "error",
          title: "Write failed verification",
          details: [
            sentence(plainMessage(err)),
            `${chip} doesn't hold what was written. It may be worn out, write-protected, badly seated or not the chip that was picked.`,
          ],
        }
      : {
          ...base,
          tone: "error",
          title: "Verify failed",
          details: [sentence(plainMessage(err)), `${chip} doesn't match the buffer.`],
        };
  }

  if (kind === "chip_id_mismatch") {
    return {
      ...base,
      tone: "error",
      title: "Chip ID mismatch",
      details: [
        sentence(plainMessage(err).replace(/^chip ID mismatch:\s*/i, "")),
        `The chip in the socket doesn't answer as ${chip}: it may be a different part, or badly seated. ${NOT_DONE[op]}`,
        "minipro can carry on without the ID check. That's at your own risk: the wrong settings can damage a chip.",
      ],
      retry: {
        label: `${label} anyway, ignoring the chip ID`,
        overrides: { ...overrides, ignoreChipId: true },
      },
    };
  }

  if (kind === "size_mismatch") {
    return {
      ...base,
      tone: "error",
      title: "Buffer is the wrong size",
      details: [
        sentence(plainMessage(err)),
        `minipro refused it. ${NOT_DONE[op]}`,
        "minipro can ignore the size. It then works on the bytes the buffer and the chip both have, and leaves the rest alone.",
      ],
      retry: {
        label: `${label} anyway, ignoring the size`,
        overrides: { ...overrides, ignoreSize: true },
      },
    };
  }

  if (kind === "no_programmer") {
    return {
      ...base,
      tone: "error",
      title: "The programmer didn't answer",
      details: [`minipro found no programmer. ${NOT_DONE[op]}`],
    };
  }

  if (kind === "busy") {
    return {
      ...base,
      tone: "error",
      title: "The programmer is busy",
      details: ["Another operation is still running on it."],
    };
  }

  return {
    ...base,
    tone: "error",
    title: `${label} failed`,
    details: [sentence(plainMessage(err))],
  };
}

/** The text of a confirmation dialog. */
export interface ConfirmCopy {
  title: string;
  paragraphs: string[];
  /** The button that goes ahead. */
  confirm: string;
  /** The button that backs out: the default. */
  cancel: string;
}

/** What the screen knows about the chip and buffer a confirmation is about. */
export interface ConfirmContext {
  /** How the buffer compares with the chip. */
  size: SizeCheck;
  /** The buffer's length in bytes, when there is one. */
  bufferLength: number | null;
  /** Why the programmer may not take the chip, if minipro says it doesn't. */
  availability: string | null;
}

function sizeParagraph(size: SizeCheck, verb: "write" | "verify"): string | null {
  if (size.status === "short") {
    const missing = formatByteCount(size.chip - size.buffer);
    return verb === "write"
      ? `The buffer is ${formatByteCount(size.buffer)} and the chip holds ${formatByteCount(size.chip)}: ${missing} short. burnwright won't pad it. If you go on, minipro is told to ignore the size and writes the bytes there are; the rest of the chip stays as the erase left it.`
      : `The buffer is ${formatByteCount(size.buffer)} and the chip holds ${formatByteCount(size.chip)}: ${missing} short. minipro won't verify an image of the wrong size unless it's told to ignore the size. If you go on, it compares the bytes the buffer has; the last ${missing} of the chip are not checked.`;
  }
  if (size.status === "long") {
    const extra = formatByteCount(size.buffer - size.chip);
    return verb === "write"
      ? `The buffer is ${formatByteCount(size.buffer)} and the chip holds ${formatByteCount(size.chip)}: ${extra} too many. burnwright won't cut it down. If you go on, minipro is told to ignore the size and writes what fits; the last ${extra} of the buffer are not written.`
      : `The buffer is ${formatByteCount(size.buffer)} and the chip holds ${formatByteCount(size.chip)}: ${extra} too many. minipro won't verify an image of the wrong size unless it's told to ignore the size. If you go on, it compares what fits on the chip; the last ${extra} of the buffer are not checked.`;
  }
  if (size.status === "unknown" && verb === "write") {
    return "minipro gives no image size for this chip, so burnwright hasn't checked the buffer against it. minipro makes its own check when it writes, and stops if the size is wrong.";
  }
  return null;
}

export function confirmCopy(confirm: Confirm, context: ConfirmContext): ConfirmCopy {
  switch (confirm.kind) {
    case "write": {
      const { chip } = confirm;
      const mismatch = isSizeMismatch(context.size);
      const paragraphs = [
        context.bufferLength === null
          ? `This replaces what's on ${chip} with the buffer. minipro erases the chip first if it needs erasing. It can't be undone.`
          : `This replaces what's on ${chip} with the buffer (${formatByteCount(context.bufferLength)}). minipro erases the chip first if it needs erasing. It can't be undone.`,
      ];
      if (mismatch) {
        const size = sizeParagraph(context.size, "write");
        if (size) paragraphs.push(size);
      } else if (confirm.overrides.ignoreSize) {
        // minipro already refused this buffer as the wrong size, and the
        // user chose to go on: its check is off for this run.
        paragraphs.push(
          context.size.status === "unknown"
            ? "minipro gives no image size for this chip, so burnwright can't say how far off the buffer is. minipro is told to ignore the size: it writes the bytes the buffer and the chip both have, and leaves the rest."
            : "minipro is told to ignore the image size: it writes the bytes the buffer and the chip both have, and leaves the rest.",
        );
      } else {
        const size = sizeParagraph(context.size, "write");
        if (size) paragraphs.push(size);
      }
      if (confirm.overrides.ignoreChipId) {
        paragraphs.push(
          "minipro is told to carry on even though the chip's ID doesn't match. If this isn't the chip you picked, the write can damage it.",
        );
      }
      if (context.availability) paragraphs.push(context.availability);
      return {
        title: `Write to ${chip}?`,
        paragraphs,
        confirm:
          mismatch || confirm.overrides.ignoreChipId || confirm.overrides.ignoreSize
            ? `Write ${chip} anyway`
            : `Write ${chip}`,
        cancel: "Don't write",
      };
    }
    case "erase": {
      const { chip } = confirm;
      const paragraphs = [`Everything on ${chip} is erased. It can't be undone.`];
      if (confirm.overrides.ignoreChipId) {
        paragraphs.push(
          "minipro is told to carry on even though the chip's ID doesn't match. If this isn't the chip you picked, the erase can damage it.",
        );
      }
      if (context.availability) paragraphs.push(context.availability);
      return {
        title: `Erase ${chip}?`,
        paragraphs,
        confirm: confirm.overrides.ignoreChipId ? `Erase ${chip} anyway` : `Erase ${chip}`,
        cancel: "Don't erase",
      };
    }
    case "verify_size":
      return {
        title: "The buffer and the chip are different sizes",
        paragraphs: [
          sizeParagraph(context.size, "verify") ??
            `The buffer isn't the size of ${confirm.chip}. If you go on, minipro compares the bytes both have.`,
        ],
        confirm: "Verify what both have",
        cancel: "Don't verify",
      };
    case "cancel":
      return confirm.op === "write"
        ? {
            title: "Stop the write?",
            paragraphs: [
              `Stopping now leaves ${confirm.chip} half-programmed. It will need erasing or writing again before it's any use.`,
            ],
            confirm: "Stop the write",
            cancel: "Keep writing",
          }
        : {
            title: "Stop the erase?",
            paragraphs: [
              `Stopping now leaves ${confirm.chip} half-erased. It will need erasing again before it's any use.`,
            ],
            confirm: "Stop the erase",
            cancel: "Keep erasing",
          };
    case "replace_buffer": {
      const by = confirm.by === "read" ? "Reading the chip" : "Opening a file";
      return {
        title: "Replace the buffer?",
        paragraphs: [
          confirm.unsaved === "read"
            ? `The buffer holds a chip read that hasn't been saved to a file. ${by} replaces it.`
            : `The buffer has edits that haven't been saved to a file. ${by} replaces them.`,
        ],
        confirm: "Replace the buffer",
        cancel: "Keep the buffer",
      };
    }
    case "close": {
      const { stop, unsaved } = confirm;
      const paragraphs: string[] = [];
      if (stop) {
        paragraphs.push(
          stop.op === "write"
            ? `A write to ${stop.chip} is running. Closing stops it and leaves ${stop.chip} half-programmed: it will need erasing or writing again before it's any use.`
            : `An erase of ${stop.chip} is running. Closing stops it and leaves ${stop.chip} half-erased: it will need erasing again before it's any use.`,
        );
      }
      if (unsaved === "read") {
        paragraphs.push(
          "The buffer holds a chip read that hasn't been saved to a file. Closing loses it.",
        );
      } else if (unsaved === "edits") {
        paragraphs.push(
          "The buffer has edits that haven't been saved to a file. Closing loses them.",
        );
      }
      if (!stop) {
        return {
          title: "Close without saving?",
          paragraphs,
          confirm: "Close without saving",
          cancel: "Keep burnwright open",
        };
      }
      return stop.op === "write"
        ? {
            title: "Stop the write and close?",
            paragraphs,
            confirm: "Stop the write and close",
            cancel: "Keep writing",
          }
        : {
            title: "Stop the erase and close?",
            paragraphs,
            confirm: "Stop the erase and close",
            cancel: "Keep erasing",
          };
    }
  }
}
