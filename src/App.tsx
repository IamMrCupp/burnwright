import { useState } from "react";
import { engine, type DeviceInfo } from "./lib/engine";
import "./App.css";

function App() {
  const [status, setStatus] = useState("Idle");
  const [device, setDevice] = useState<DeviceInfo | null>(null);

  async function detect() {
    setStatus("Detecting…");
    setDevice(null);
    try {
      setDevice(await engine.detect());
      setStatus("Device detected");
    } catch (err) {
      // Expected in Phase 0: the engine command is still a stub.
      setStatus(`Engine not wired yet — ${String(err)}`);
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

      <p>
        <small>
          Engine commands are stubbed in this scaffold — they return a “not
          implemented” error until issue #6 wires them to minipro.
        </small>
      </p>
    </main>
  );
}

export default App;
