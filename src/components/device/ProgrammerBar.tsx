import { memo, useId } from "react";
import { PROGRAMMERS, programmerFromModel, type Programmer } from "../../lib/engine";
import type { ProgrammerState } from "../../lib/device/state";
import { DeviceNotices, ProgrammerDiagnosis } from "../detect";

export interface ProgrammerBarProps {
  programmer: ProgrammerState;
  /** An operation is running: detect and the model choice wait. */
  busy: boolean;
  onDetect: () => void;
  onChoose: (programmer: Programmer) => void;
}

function statusText(programmer: ProgrammerState): string {
  const { status, device } = programmer;
  switch (status) {
    case "unknown":
      return "Not looked for yet";
    case "detecting":
      return "Looking for a programmer…";
    case "found":
      if (!device) return "Programmer found";
      return device.firmware
        ? `${device.programmer}, firmware ${device.firmware}`
        : `${device.programmer}, firmware not reported`;
    case "none":
      return programmer.diagnosing
        ? "No programmer found. Checking why…"
        : "No programmer found";
    case "error":
      return `Detect failed: ${programmer.error ?? "unknown error"}`;
  }
}

/**
 * The connected programmer: its model and firmware, minipro's warnings about
 * it, and, when there is none, why not. With nothing connected it also takes
 * the model whose chip list the picker should search.
 */
export const ProgrammerBar = memo(function ProgrammerBar({
  programmer,
  busy,
  onDetect,
  onChoose,
}: ProgrammerBarProps) {
  const selectId = useId();
  const { status, device } = programmer;
  const detecting = status === "detecting";
  const found = status === "found" && device !== null;
  // A detected model the chip commands don't know still needs a list.
  const hasOwnList = found && programmerFromModel(device.programmer) !== null;

  return (
    <section className="panel programmer" aria-label="Programmer">
      <div className="panel-bar">
        <h2>Programmer</h2>
        <button type="button" onClick={onDetect} disabled={detecting || busy}>
          {found ? "Detect again" : "Detect"}
        </button>
      </div>
      <p
        role="status"
        className={`programmer-status programmer-status-${status}`}
      >
        {statusText(programmer)}
      </p>

      {!hasOwnList && !detecting && (
        <div className="programmer-model">
          <label htmlFor={selectId}>Show the chip list for</label>
          <select
            id={selectId}
            value={programmer.manual}
            disabled={busy}
            onChange={(event) => onChoose(event.target.value as Programmer)}
          >
            {PROGRAMMERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <p className="hint">
            {found
              ? `burnwright has no chip list of its own for the ${device.programmer}. Pick the closest model.`
              : "You can look chips up with nothing connected. Reading and writing need a programmer."}
          </p>
        </div>
      )}

      {found && <DeviceNotices device={device} />}
      {status === "none" && programmer.diagnosis && (
        <ProgrammerDiagnosis diagnosis={programmer.diagnosis} />
      )}
    </section>
  );
});
