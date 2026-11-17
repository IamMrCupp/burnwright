import { memo, useId } from "react";
import {
  OP_LABELS,
  type Availability,
  type OpKind,
  type Outcome,
  type RunningOp,
} from "../../lib/device/state";

/** The operations, in the order they're shown. Write and Erase change the chip. */
const OPERATIONS: readonly OpKind[] = [
  "read",
  "verify",
  "blank_check",
  "check",
  "erase",
  "write",
];

const DESTRUCTIVE: readonly OpKind[] = ["erase", "write"];

const HINTS: Record<OpKind, string> = {
  read: "Read the chip into the buffer",
  verify: "Compare the chip with the buffer",
  blank_check: "Check that the chip is erased",
  check: "Read the chip's ID and, on a TL866II+, test pin contact. Changes nothing.",
  erase: "Erase the chip. Asks first.",
  write: "Write the buffer to the chip. Asks first.",
};

export interface OperationsPanelProps {
  /** Whether each operation can start now, and if not, why. */
  availability: Record<OpKind, Availability>;
  running: RunningOp | null;
  outcome: Outcome | null;
  onRun: (op: OpKind) => void;
  onCancel: () => void;
  onRetry: () => void;
}

function progressLabel(running: RunningOp): string {
  if (running.phase === "readback") {
    return `Reading ${running.chip} back to show the differences${running.stage ? `: ${running.stage}` : ""}`;
  }
  return `${OP_LABELS[running.op]} ${running.chip}: ${running.stage ?? "starting"}`;
}

/**
 * The operation buttons, the progress of the one that's running with its
 * Cancel button, and how the last one ended.
 */
export const OperationsPanel = memo(function OperationsPanel({
  availability,
  running,
  outcome,
  onRun,
  onCancel,
  onRetry,
}: OperationsPanelProps) {
  const reasonId = useId();
  // Why buttons are off: usually one reason for all of them, sometimes a
  // second for the two that need a buffer.
  const reasons = running
    ? []
    : [...new Set(OPERATIONS.map((op) => availability[op].reason).filter(Boolean))];

  return (
    <section className="panel ops" aria-label="Operations">
      <div className="ops-buttons" role="group" aria-label="Chip operations">
        {OPERATIONS.map((op) => (
          <button
            key={op}
            type="button"
            className={
              DESTRUCTIVE.includes(op)
                ? op === DESTRUCTIVE[0]
                  ? "button-danger ops-apart"
                  : "button-danger"
                : undefined
            }
            disabled={!availability[op].enabled}
            aria-describedby={availability[op].enabled ? undefined : reasonId}
            title={availability[op].reason ?? HINTS[op]}
            onClick={() => onRun(op)}
          >
            {OP_LABELS[op]}
          </button>
        ))}
      </div>
      <p id={reasonId} className="hint ops-reason">
        {reasons.join(" ")}
      </p>

      {running && (
        <div className="ops-progress">
          <p role="status">{progressLabel(running)}</p>
          <div className="ops-progress-row">
            <progress
              max={100}
              value={running.percent ?? undefined}
              aria-label={`${OP_LABELS[running.op]} progress`}
            />
            <span className="ops-percent" aria-hidden="true">
              {running.percent === null ? "" : `${running.percent}%`}
            </span>
            <button type="button" onClick={onCancel} disabled={running.cancelling}>
              {running.cancelling ? "Stopping…" : "Cancel"}
            </button>
          </div>
        </div>
      )}

      {outcome && !running && (
        <article
          className={`outcome outcome-${outcome.tone}`}
          role={outcome.tone === "error" ? "alert" : "status"}
        >
          <h3>{outcome.title}</h3>
          {outcome.details.map((detail) => (
            <p key={detail}>{detail}</p>
          ))}
          {outcome.retry && (
            <button type="button" onClick={onRetry}>
              {outcome.retry.label}
            </button>
          )}
        </article>
      )}
    </section>
  );
});
