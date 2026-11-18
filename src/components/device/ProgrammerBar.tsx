import { memo, useId } from "react";
import {
  PROGRAMMERS,
  programmerFromModel,
  type AlgorithmFile,
  type Programmer,
} from "../../lib/engine";
import type { ProgrammerState } from "../../lib/device/state";
import { DeviceNotices, ProgrammerDiagnosis } from "../detect";

export interface ProgrammerBarProps {
  programmer: ProgrammerState;
  /** An operation is running: detect and the model choice wait. */
  busy: boolean;
  onDetect: () => void;
  onChoose: (programmer: Programmer) => void;
  /**
   * Where the detected programmer's `algorithm.xml` stands. `undefined`
   * for a programmer that doesn't take one; `null` when the engine
   * couldn't say.
   */
  algorithms?: AlgorithmFile | null;
  /**
   * Why the algorithm file remembered from the last run couldn't be handed
   * to the engine, when it couldn't.
   */
  algorithmsRestoreError?: string | null;
  /** A file panel is up or a file is being loaded or saved: the algorithm file buttons wait. */
  fileBusy?: boolean;
  onChooseAlgorithms?: () => void;
  onClearAlgorithms?: () => void;
}

/** Which file minipro will read its bitstreams from, in a line. */
function algorithmText(algorithms: AlgorithmFile | null): string {
  if (!algorithms) return "not known";
  if (algorithms.configured !== null) {
    return algorithms.found === null
      ? `${algorithms.configured} (chosen here, not found)`
      : `${algorithms.configured} (chosen here)`;
  }
  return algorithms.found === null
    ? "none chosen"
    : `${algorithms.found} (found by minipro)`;
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
  algorithms,
  algorithmsRestoreError = null,
  fileBusy = false,
  onChooseAlgorithms,
  onClearAlgorithms,
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

      {found && <DeviceNotices device={device} algorithms={algorithms ?? null} />}
      {found && algorithms !== undefined && (
        <div className="programmer-algorithms">
          <p>
            <span className="programmer-algorithms-label">Algorithm file</span>{" "}
            <span className="programmer-algorithms-file">{algorithmText(algorithms)}</span>
          </p>
          {algorithmsRestoreError && (
            <p className="notice notice-error" role="alert">
              {algorithmsRestoreError}
            </p>
          )}
          <div className="programmer-algorithms-actions">
            <button type="button" onClick={onChooseAlgorithms} disabled={busy || fileBusy}>
              Choose file…
            </button>
            {algorithms?.configured != null && (
              <button type="button" onClick={onClearAlgorithms} disabled={busy || fileBusy}>
                Clear
              </button>
            )}
          </div>
          <p className="hint">
            Your own copy of XGecu's algorithm.xml. burnwright reads it where it is and
            doesn't ship, download or copy it.
          </p>
        </div>
      )}
      {status === "none" && programmer.diagnosis && (
        <ProgrammerDiagnosis diagnosis={programmer.diagnosis} />
      )}
    </section>
  );
});
