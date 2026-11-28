import { memo, useLayoutEffect, useRef, useState } from "react";
import { logText, type LogLine } from "../../lib/device/state";

export interface LogPaneProps {
  log: readonly LogLine[];
  onClear: () => void;
  /** The tool whose commands these are. minipro unless said otherwise. */
  tool?: string;
}

type CopyState = "idle" | "copied" | "failed";

/**
 * Every command burnwright ran (minipro's, or `tool`'s) and what it
 * printed, newest at the bottom. The text can be selected, or copied whole
 * for a bug report.
 */
export const LogPane = memo(function LogPane({ log, onClear, tool = "minipro" }: LogPaneProps) {
  const linesRef = useRef<HTMLDivElement>(null);
  const [copy, setCopy] = useState<CopyState>("idle");

  // Follow the newest line, before the browser paints, so a change and the
  // scroll that goes with it are drawn together. With the scroll after the
  // paint, the app's WebKit could leave the whole box undrawn until it was
  // scrolled by hand, after an update that rewrote every line and moved the
  // log at once: turning "Hide file paths" on or off with Inspect's strings
  // open. Chromium never did it.
  useLayoutEffect(() => {
    const lines = linesRef.current;
    if (lines) lines.scrollTop = lines.scrollHeight;
  }, [log]);

  async function copyLog() {
    try {
      await navigator.clipboard.writeText(logText(log));
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }

  return (
    <section className="panel log" aria-label="Log">
      <div className="panel-bar">
        <h2>Log</h2>
        <div className="log-actions">
          <span role="status" className="hint">
            {copy === "copied" && "Copied"}
            {copy === "failed" && "Couldn't copy: select the text instead."}
          </span>
          <button type="button" onClick={copyLog} disabled={log.length === 0}>
            Copy log
          </button>
          <button
            type="button"
            onClick={() => {
              setCopy("idle");
              onClear();
            }}
            disabled={log.length === 0}
          >
            Clear log
          </button>
        </div>
      </div>
      <div
        ref={linesRef}
        className="log-lines"
        role="log"
        aria-label={`${tool} commands and output`}
        tabIndex={0}
      >
        {log.length === 0 ? (
          <p className="hint">
            Nothing yet. Each operation's {tool} command line and output show up here.
          </p>
        ) : (
          log.map((line) => (
            <div key={line.id} className={`log-line log-${line.kind}`}>
              {line.kind === "command" ? `$ ${line.text}` : line.text}
            </div>
          ))
        )}
      </div>
    </section>
  );
});
