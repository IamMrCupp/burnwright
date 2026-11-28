import { memo, useCallback, useRef } from "react";
import { isSizeMismatch, sizeCheckText, type SizeCheck } from "../../lib/device/chip";
import { fileName, formatByteCount } from "../../lib/device/format";
import type { BufferState, DiffState, InspectState, Unsaved } from "../../lib/device/state";
import { HexDiffView, HexEditor, type EditorMemory, type HexEditorHandle } from "../hexview";
import { InspectPanel } from "./InspectPanel";

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
  /** The scan of the buffer for known formats, once one has been asked for. */
  inspect: InspectState | null;
  /** Keep the strings a scan found off the screen: the window is on a live stream. */
  coverStrings?: boolean;
  /** Holds the editor's edits, undo history and cursor while this panel is off screen. */
  editorMemory?: EditorMemory;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onEdit: (bytes: Uint8Array, edited: boolean) => void;
  onCloseDiff: () => void;
  onInspect: () => void;
  onCancelInspect: () => void;
  onCloseInspect: () => void;
  /** Save part of the buffer, something a scan found, to a file the user picks. */
  onSaveRegion: (offset: number, size: number, kind: string) => void;
}

function describeSource(buffer: BufferState): string {
  if (buffer.path) return fileName(buffer.path);
  return buffer.source.kind === "chip" ? `Read from ${buffer.source.chip}` : "Untitled";
}

/**
 * The working image: the hex editor, the file buttons, and how the buffer's
 * size compares with the chip. After a failed verify it also shows the chip
 * against the buffer, and after Inspect what a scan found in it.
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
  inspect,
  coverStrings = false,
  editorMemory,
  onOpen,
  onSave,
  onSaveAs,
  onEdit,
  onCloseDiff,
  onInspect,
  onCancelInspect,
  onCloseInspect,
  onSaveRegion,
}: BufferPanelProps) {
  const onChange = useCallback(
    (bytes: Uint8Array, info: { dirty: boolean }) => onEdit(bytes, info.dirty),
    [onEdit],
  );
  const editor = useRef<HexEditorHandle>(null);
  const length = buffer?.bytes.length ?? 0;
  // A finding's offset is inside the bytes that were scanned. Held to the
  // buffer as it is now anyway: the cursor has to land on a byte.
  const onJump = useCallback(
    (offset: number) => {
      if (length > 0) editor.current?.goToIndex(Math.min(offset, length - 1));
    },
    [length],
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
            {/* A scan touches no chip, so it doesn't wait for an operation. */}
            <button
              type="button"
              onClick={onInspect}
              disabled={!buffer || inspect?.status === "scanning"}
              title="Look for known formats in the buffer: file systems, compressed data, boot images"
            >
              Inspect
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
              ref={editor}
              data={buffer.original}
              onChange={onChange}
              memory={editorMemory}
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

      {inspect && buffer && (
        <InspectPanel
          inspect={inspect}
          onScan={onInspect}
          onCancel={onCancelInspect}
          onClose={onCloseInspect}
          onJump={onJump}
          coverStrings={coverStrings}
          onSaveRegion={onSaveRegion}
          saveBlocked={
            busy
              ? "Wait for the running operation to finish."
              : fileBusy
                ? "A file is being opened or saved."
                : null
          }
        />
      )}
    </>
  );
});
