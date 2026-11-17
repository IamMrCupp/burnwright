import { memo, useCallback } from "react";
import { isSizeMismatch, sizeCheckText, type SizeCheck } from "../../lib/device/chip";
import { fileName, formatByteCount } from "../../lib/device/format";
import type { BufferState, DiffState, Unsaved } from "../../lib/device/state";
import { HexDiffView, HexEditor } from "../hexview";

export interface BufferPanelProps {
  buffer: BufferState | null;
  /** What the buffer holds that isn't in a file, if anything. */
  unsaved: Unsaved | null;
  /** How the buffer compares with the selected chip. */
  size: SizeCheck;
  /** The selected chip's name, for the size line. */
  chip: string | null;
  /** Why the last open or save failed. */
  fileError: string | null;
  /** An operation is running: the buffer can't change under it. */
  busy: boolean;
  /** A file is being opened or saved: the file buttons wait. */
  fileBusy: boolean;
  /** The chip's contents after a failed verify, to show against the buffer. */
  diff: DiffState | null;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onEdit: (bytes: Uint8Array, edited: boolean) => void;
  onCloseDiff: () => void;
}

function describeSource(buffer: BufferState): string {
  if (buffer.path) return fileName(buffer.path);
  return buffer.source.kind === "chip" ? `Read from ${buffer.source.chip}` : "Untitled";
}

/**
 * The working image: the hex editor, the file buttons, and how the buffer's
 * size compares with the chip. After a failed verify it also shows the chip
 * against the buffer.
 */
export const BufferPanel = memo(function BufferPanel({
  buffer,
  unsaved,
  size,
  chip,
  fileError,
  busy,
  fileBusy,
  diff,
  onOpen,
  onSave,
  onSaveAs,
  onEdit,
  onCloseDiff,
}: BufferPanelProps) {
  const onChange = useCallback(
    (bytes: Uint8Array, info: { dirty: boolean }) => onEdit(bytes, info.dirty),
    [onEdit],
  );
  const sizeLine = chip ? sizeCheckText(size, chip) : null;
  const mismatch = isSizeMismatch(size);

  return (
    <>
      <section className="panel buffer" aria-label="Buffer">
        <div className="panel-bar">
          <h2>Buffer</h2>
          <div className="buffer-actions">
            <button type="button" onClick={onOpen} disabled={busy || fileBusy}>
              Open…
            </button>
            <button type="button" onClick={onSave} disabled={!buffer || busy || fileBusy}>
              Save
            </button>
            <button type="button" onClick={onSaveAs} disabled={!buffer || busy || fileBusy}>
              Save as…
            </button>
          </div>
        </div>

        {fileError && (
          <p className="notice notice-error" role="alert">
            {fileError}
          </p>
        )}

        {buffer ? (
          <>
            <p className="buffer-summary">
              <span className="buffer-name" title={buffer.path ?? undefined}>
                {describeSource(buffer)}
              </span>
              <span>{formatByteCount(buffer.bytes.length)}</span>
              {unsaved && (
                <span className="buffer-unsaved">
                  {unsaved === "read" && !buffer.edited
                    ? "Not saved to a file"
                    : "Edited, not saved"}
                </span>
              )}
            </p>
            {sizeLine && (
              <p
                className={
                  mismatch ? "notice notice-warning buffer-size" : "hint buffer-size"
                }
                role={mismatch ? "alert" : undefined}
              >
                {mismatch ? "Size mismatch: " : ""}
                {sizeLine}
                {mismatch &&
                  " burnwright never pads or cuts the buffer: a write or verify shows you this and asks first."}
              </p>
            )}
            <HexEditor
              data={buffer.original}
              onChange={onChange}
              readOnly={busy}
              height="auto"
              aria-label="Buffer bytes"
            />
          </>
        ) : (
          <p className="buffer-empty">
            The buffer is empty. Open a .bin or Intel HEX file, or read a chip.
          </p>
        )}
      </section>

      {diff && buffer && (
        <section className="panel diff" aria-label="Differences">
          <div className="panel-bar">
            <h2>{diff.chip} against the buffer</h2>
            <button type="button" onClick={onCloseDiff}>
              Close
            </button>
          </div>
          <p className="hint">
            What the chip held when it was read back after the failed{" "}
            {diff.after === "write" ? "write" : "verify"}, with every byte that differs
            from the buffer marked.
          </p>
          <HexDiffView
            a={diff.read}
            b={buffer.bytes}
            aLabel="Chip"
            bLabel="Buffer"
            height={220}
            aria-label="Chip bytes that differ from the buffer"
          />
        </section>
      )}
    </>
  );
});
