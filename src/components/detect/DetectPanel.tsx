import { useState } from "react";
import {
  engine,
  errorMessage,
  isNoProgrammer,
  type DeviceInfo,
  type Diagnosis,
} from "../../lib/engine";
import { DeviceNotices } from "./DeviceNotices";
import { ProgrammerDiagnosis } from "./ProgrammerDiagnosis";

/**
 * The Detect button and what it found, with any firmware or support warning
 * minipro printed. When minipro finds no programmer, it asks the OS why and
 * shows the fix.
 */
export function DetectPanel() {
  const [status, setStatus] = useState("Idle");
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);

  async function detect() {
    setStatus("Detecting…");
    setDevice(null);
    setDiagnosis(null);
    try {
      setDevice(await engine.detect());
      setStatus("Device detected");
    } catch (err) {
      if (!isNoProgrammer(err)) {
        setStatus(`Detect failed: ${errorMessage(err)}`);
        return;
      }
      setStatus("No programmer found. Checking why…");
      // diagnoseProgrammer doesn't reject; if the IPC itself fails, the
      // status line is all there is to show.
      setDiagnosis(await engine.diagnoseProgrammer().catch(() => null));
      setStatus("No programmer found");
    }
  }

  return (
    <>
      <div className="row">
        <button type="button" onClick={detect}>
          Detect device
        </button>
      </div>

      <p role="status">{status}</p>

      {device && <pre>{JSON.stringify(device, null, 2)}</pre>}
      {device && <DeviceNotices device={device} />}
      {diagnosis && <ProgrammerDiagnosis diagnosis={diagnosis} />}
    </>
  );
}
