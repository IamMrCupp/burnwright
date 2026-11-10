import { useEffect, useMemo, useState } from "react";
import { HexDiffView, HexEditor } from "./components/hexview";
import {
  engine,
  errorMessage,
  type AppInfo,
  type DeviceInfo,
} from "./lib/engine";
import { makeDiffSample } from "./lib/sampleBuffer";
import "./App.css";

function App() {
  const [status, setStatus] = useState("Idle");
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const sample = useMemo(() => makeDiffSample(), []);
  const [edited, setEdited] = useState<Uint8Array | null>(null);

  useEffect(() => {
    engine.appInfo().then(setInfo, () => setInfo(null));
  }, []);

  async function detect() {
    setStatus("Detecting…");
    setDevice(null);
    try {
      setDevice(await engine.detect());
      setStatus("Device detected");
    } catch (err) {
      setStatus(`Detect failed — ${errorMessage(err)}`);
    }
  }

  return (
    <main className="container">
      <h1>burnwright</h1>
      <p>
        Cross-platform GUI for XGecu / MiniPRO programmers — Phase&nbsp;0
        scaffold.
      </p>

      <div className="row">
        <button type="button" onClick={detect}>
          Detect device
        </button>
      </div>

      <p>{status}</p>

      {device && <pre>{JSON.stringify(device, null, 2)}</pre>}

      <section className="hex-demo">
        <h2>Edit the read</h2>
        <HexEditor data={sample.read} onChange={setEdited} height={360} />
      </section>

      <section className="hex-demo">
        <h2>Read vs file</h2>
        <p>
          <small>
            Generated 16&nbsp;MiB samples, not read from a device: the “file”
            differs in a few places and is 256&nbsp;bytes short. Edits above
            show up here.
          </small>
        </p>
        <HexDiffView
          a={edited ?? sample.read}
          b={sample.file}
          aLabel="Read"
          bLabel="File"
          height={360}
        />
      </section>

      <footer>
        <small>
          {info
            ? `burnwright v${info.version} · minipro ${info.minipro}`
            : "burnwright"}
        </small>
      </footer>
    </main>
  );
}

export default App;
