// What the stream page is told about the device screen, and nothing else.
//
// The page goes on a live stream. It gets a fixed list of fields, each
// copied out by name, not the screen's state with the private parts taken
// out: a field added to `DeviceState` later stays off stream until it's
// added here too. So no file path, no log line and no byte of the buffer
// can get there by accident.
//
// The Rust side holds the same list (`src-tauri/src/stream/status.rs`) and
// turns away anything beyond it.
import type { DeviceState, OpKind, Outcome } from "../device/state";

/** Mirrors `stream::StreamStatus`. */
export interface StreamStatus {
  /** The detected programmer's model, e.g. "T48". */
  programmer: string | null;
  /** The chip being worked on, or the one selected, e.g. "W25Q32BV@SOIC8". */
  chip: string | null;
  running: {
    operation: OpKind;
    /** 0 to 100, or `null` when the programmer hasn't said. */
    percent: number | null;
  } | null;
  outcome: {
    operation: OpKind;
    tone: Outcome["tone"];
  } | null;
}

/** The stream page's view of the device screen. */
export function streamStatus(state: DeviceState): StreamStatus {
  const { programmer, chip, running, outcome } = state;
  return {
    programmer:
      programmer.status === "found" && programmer.device
        ? programmer.device.programmer
        : null,
    chip: running?.chip ?? chip.selected?.name ?? null,
    running: running
      ? {
          // Reading the chip back after a failed verify is a read: calling it
          // "Write" again would say the chip is being written twice.
          operation: running.phase === "readback" ? "read" : running.op,
          percent:
            running.percent === null
              ? null
              : Math.max(0, Math.min(100, Math.round(running.percent))),
        }
      : null,
    outcome: outcome ? { operation: outcome.op, tone: outcome.tone } : null,
  };
}
