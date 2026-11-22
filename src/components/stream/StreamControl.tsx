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

  const commitPort = () => {
    if (portOk) void controller.setPort(typed);
  };

  /**
   * Put the panel away. A port that was typed and never committed is settled
   * first: taken if the page can be served on it, dropped if not. The field
   * goes away with the panel without ever blurring, so leaving it to `onBlur`
   * left the field saying one port and the address another.
   */
  const close = () => {
    if (portOk) void controller.setPort(typed);
    else setPort(String(settings.port));
    setOpen(false);
  };
  // The listeners below are set up once per opening; this is the `close`
  // that knows what's in the field now.
  const closeNow = useRef(close);
  useEffect(() => {
    closeNow.current = close;
  });

  // Escape, or a click anywhere else, puts the panel away.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeNow.current();
      root.current?.querySelector<HTMLElement>(".stream-toggle")?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) closeNow.current();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

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
          if (open) close();
          else setOpen(true);
          setCopied(false);
        }}
      >
        <span className={`stream-dot stream-dot-${status}`} aria-hidden="true" />
        Stream page: {status}
      </button>
      {settings.hidePaths && (
        // Said in the window itself, so it can be checked before going live.
        <span className="stream-hidden">Paths hidden</span>
      )}
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
          <label className="stream-row stream-apart">
            <input
              type="checkbox"
              checked={settings.hidePaths}
              onChange={(event) => controller.setHidePaths(event.target.checked)}
            />
            Hide file paths in this window
          </label>
          <p className="hint">
            For when OBS captures the window itself. Every path, in the log and everywhere
            else, reads [hidden]. Files open and save as usual, and the system's own open and
            save panels aren't covered.
          </p>
        </section>
      )}
    </div>
  );
}
