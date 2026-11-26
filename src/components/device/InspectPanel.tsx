import { memo } from "react";
import {
  formatByteCount,
  formatCount,
  formatOffset,
  formatSize,
  sentence,
} from "../../lib/device/format";
import type { InspectState } from "../../lib/device/state";
import type { InspectConfidence } from "../../lib/engine";
import { EntropyStrip } from "./EntropyStrip";
import { StringsList } from "./StringsList";

/**
 * How many findings are drawn. A dump can hold thousands, and nobody reads a
 * table that long; the line under it says how many were left out.
 */
export const INSPECT_ROW_LIMIT = 500;

const CONFIDENCE: Record<InspectConfidence, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

export interface InspectPanelProps {
  inspect: InspectState;
  /** Scan the buffer as it is now. */
  onScan: () => void;
  onCancel: () => void;
  onClose: () => void;
  /** Put the hex editor's cursor on this offset. */
  onJump: (offset: number) => void;
  /** Count the strings and draw none: the window is on a live stream. */
  coverStrings?: boolean;
}

/**
 * What a scan found in the buffer: how random each stretch of it looks, the
 * known formats in it and where each starts, and the text in it. A row puts
 * the hex editor's cursor on its offset, and so does a point on the strip.
 */
export const InspectPanel = memo(function InspectPanel({
  inspect,
  onScan,
  onCancel,
  onClose,
  onJump,
  coverStrings = false,
}: InspectPanelProps) {
  const scanning = inspect.status === "scanning";
  return (
    <section className="panel inspect" aria-label="Contents">
      <div className="panel-bar">
        <h2>What&rsquo;s inside</h2>
        <div className="buffer-actions">
          {scanning ? (
            <button type="button" onClick={onCancel}>
              Cancel scan
            </button>
          ) : (
            <button type="button" onClick={onScan}>
              Scan again
            </button>
          )}
          <button type="button" onClick={onClose} aria-label="Close contents">
            Close
          </button>
        </div>
      </div>
      <Body inspect={inspect} onJump={onJump} coverStrings={coverStrings} />
    </section>
  );
});

function Body({
  inspect,
  onJump,
  coverStrings,
}: Pick<InspectPanelProps, "inspect" | "onJump"> & { coverStrings: boolean }) {
  switch (inspect.status) {
    case "scanning":
      return <p role="status">Scanning {formatByteCount(inspect.bytes)}…</p>;
    case "cancelled":
      return (
        <p className="hint" role="status">
          Scan cancelled.
        </p>
      );
    case "failed":
      return (
        <p className="notice notice-error" role="alert">
          {sentence(inspect.message)} That&rsquo;s the scan failing, not an empty
          result. The buffer is as it was.
        </p>
      );
    case "done":
      return <Report inspect={inspect} onJump={onJump} coverStrings={coverStrings} />;
  }
}

function Report({
  inspect,
  onJump,
  coverStrings,
}: {
  inspect: Extract<InspectState, { status: "done" }>;
  onJump: (offset: number) => void;
  coverStrings: boolean;
}) {
  const { report, stale } = inspect;
  const total = report.findings.length;
  const rows = total > INSPECT_ROW_LIMIT ? report.findings.slice(0, INSPECT_ROW_LIMIT) : report.findings;
  return (
    <>
      {stale && (
        <p className="notice notice-warning" role="alert">
          The buffer has been edited since this scan. An offset below may no longer
          hold what its row says. Scan again to be sure.
        </p>
      )}
      <EntropyStrip entropy={report.entropy} len={report.len} onJump={onJump} />
      {total === 0 ? (
        <>
          <p role="status">Nothing recognised in these {formatByteCount(report.len)}.</p>
          <p className="hint">
            The scanner knows file systems, compressed data, boot images and other
            containers. Plain code and data don&rsquo;t show up in it, and neither
            does an erased chip.
          </p>
        </>
      ) : (
        <>
          <p className="hint" role="status">
            {formatCount(total)} found in {formatByteCount(report.len)}. Pick one to go
            to it in the buffer.
          </p>
          <div className="inspect-table">
            <table aria-label="Formats found">
              <thead>
                <tr>
                  <th scope="col">Offset</th>
                  <th scope="col">Size</th>
                  <th scope="col">Type</th>
                  <th scope="col">Confidence</th>
                  <th scope="col">What it is</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((finding, index) => (
                  <tr
                    // Two formats can start at one offset; the position is
                    // the only thing sure to differ.
                    key={index}
                    className={`inspect-row inspect-${finding.confidence}`}
                    onClick={() => onJump(finding.offset)}
                  >
                    <td>
                      {/* The row's click does the work: this is what a
                          keyboard lands on. */}
                      <button
                        type="button"
                        className="inspect-offset"
                        aria-label={`Go to ${formatOffset(finding.offset)}, ${finding.kind}`}
                      >
                        {formatOffset(finding.offset)}
                      </button>
                    </td>
                    <td title={finding.size === null ? undefined : formatByteCount(finding.size)}>
                      {finding.size === null ? "unknown" : formatSize(finding.size)}
                    </td>
                    <td className="inspect-kind">{finding.kind}</td>
                    <td>{CONFIDENCE[finding.confidence]}</td>
                    <td className="inspect-description">{finding.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > rows.length && (
            <p className="hint">
              Showing the first {formatCount(rows.length)} of {formatCount(total)}.
            </p>
          )}
        </>
      )}
      <StringsList strings={report.strings} covered={coverStrings} onJump={onJump} />
    </>
  );
}
