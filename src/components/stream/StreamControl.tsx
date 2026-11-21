import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { StreamController } from "../../lib/stream/controller";
import {
  isStreamPort,
  MAX_STREAM_PORT,
  MIN_STREAM_PORT,
} from "../../lib/stream/settings";
import "./StreamControl.css";

export interface StreamControlProps {
  controller: StreamController;
}

/**
 * The stream page's switch: a button in the app's top bar that says whether
 * the page is being served, and a small panel under it to turn the page on,
 * pick its port and copy its address into OBS.
 */
export function StreamControl({ controller }: StreamControlProps) {
  const { settings, server } = useSyncExternalStore(controller.subscribe, controller.getState);
  const [open, setOpen] = useState(false);
  const [port, setPort] = useState(String(settings.port));
  const [copied, setCopied] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const portHintId = useId();

  const typed = Number(port);
  const portOk = port.trim() !== "" && isStreamPort(typed);

  // Escape, or a click anywhere else, puts the panel away.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      root.current?.querySelector<HTMLElement>(".stream-toggle")?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const commitPort = () => {
    if (portOk) void controller.setPort(typed);
  };

  const copy = async () => {
    if (!server?.url) return;
    try {
      await navigator.clipboard.writeText(server.url);
      setCopied(true);
    } catch {
      // The address is on screen to copy by hand.
    }
  };

  const status = server?.running ? "on" : server?.error ? "problem" : "off";

  return (
    <div className="stream-control" ref={root}>
      <button
        type="button"
        className="stream-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen(!open);
          setCopied(false);
        }}
      >
        <span className={`stream-dot stream-dot-${status}`} aria-hidden="true" />
        Stream page: {status}
      </button>
      {open && (
        <section id={panelId} className="panel stream-panel" aria-label="Stream page">
          <label className="stream-row">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) => void controller.setEnabled(event.target.checked)}
            />
            Serve a page for OBS
          </label>
          <label className="stream-row">
            Port
            <input
              type="number"
              inputMode="numeric"
              min={MIN_STREAM_PORT}
              max={MAX_STREAM_PORT}
              value={port}
              aria-invalid={!portOk}
              aria-describedby={portOk ? undefined : portHintId}
              onChange={(event) => setPort(event.target.value)}
              onBlur={commitPort}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitPort();
              }}
            />
          </label>
          {!portOk && (
            <p id={portHintId} className="stream-problem">
              Pick a port from {MIN_STREAM_PORT} to {MAX_STREAM_PORT}.
            </p>
          )}
          {server?.error && (
            <p className="stream-problem" role="alert">
              {server.error}
            </p>
          )}
          {server?.url && (
            <p className="stream-url">
              <code>{server.url}</code>
              <button type="button" onClick={() => void copy()}>
                {copied ? "Copied" : "Copy"}
              </button>
            </p>
          )}
          <p className="hint">
            In OBS, add a Browser source with this address. It shows the programmer, the chip,
            the operation and its progress. File paths, the log and the buffer stay here. Only
            this computer can open it.
          </p>
        </section>
      )}
    </div>
  );
}
