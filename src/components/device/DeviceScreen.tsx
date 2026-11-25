import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { availabilityWarning } from "../../lib/device/chip";
import type { DeviceController } from "../../lib/device/controller";
import { confirmCopy } from "../../lib/device/messages";
import {
  activeProgrammer,
  bufferSizeCheck,
  needsAlgorithmFile,
  operationAvailability,
  selectedInfo,
  unsavedBuffer,
  visibleRecent,
  type Availability,
  type OpKind,
} from "../../lib/device/state";
import { useMasked } from "../../lib/stream/useMasked";
import { BufferPanel } from "./BufferPanel";
import { ChipPicker } from "./ChipPicker";
import { ConfirmDialog } from "./ConfirmDialog";
import { LogPane } from "./LogPane";
import { OperationsPanel } from "./OperationsPanel";
import { ProgrammerBar } from "./ProgrammerBar";
import "./DeviceScreen.css";

export interface DeviceScreenProps {
  controller: DeviceController;
  /** Shown under the side column: the app's version line. */
  footer?: ReactNode;
  /** Draw every file path as "[hidden]": the window is on a live stream. */
  hidePaths?: boolean;
}

const MASK_SKIP = ["chip"] as const;

const OPS: readonly OpKind[] = ["read", "verify", "blank_check", "check", "erase", "write"];

/**
 * Where the focus goes after a confirmation whose button is now disabled:
 * the running operation's Cancel button, or the operations panel when even
 * that is off (a stop is already on its way).
 */
function operationsFocus(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>(".ops-cancel:not(:disabled)") ??
    document.querySelector<HTMLElement>(".ops")
  );
}

/**
 * The screen where a chip is picked and worked on: programmer and chip on
 * the left; operations, the buffer and the log on the right. All of its
 * state lives in the controller; this only lays it out.
 */
export function DeviceScreen({ controller, footer, hidePaths = false }: DeviceScreenProps) {
  const real = useSyncExternalStore(controller.subscribe, controller.getState);
  // Only what's drawn is masked: the controller works on the real state.
  // The chip picker is left alone. Its names come from the chip list, and
  // masking the search box would rewrite what's being typed into it.
  const state = useMasked(real, hidePaths, MASK_SKIP);
  const busy = state.running !== null;
  const programmer = activeProgrammer(state);
  const info = selectedInfo(state);
  const size = bufferSizeCheck(state);
  const chipName = state.chip.selected?.name ?? null;

  // Kept stable between renders that don't change it, so a progress tick
  // doesn't re-render the panels it has nothing to do with.
  const recent = useMemo(
    () => visibleRecent(state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.chip.recent, programmer],
  );
  const availabilityKey = OPS.map((op) => {
    const { enabled, reason } = operationAvailability(state, op);
    return `${enabled}:${reason ?? ""}`;
  }).join("|");
  const availability = useMemo(
    () =>
      Object.fromEntries(
        OPS.map((op) => [op, operationAvailability(state, op)]),
      ) as Record<OpKind, Availability>,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [availabilityKey],
  );
  const sizeKey = JSON.stringify(size);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableSize = useMemo(() => size, [sizeKey]);

  const confirm = state.confirm
    ? confirmCopy(state.confirm, {
        size,
        bufferLength: state.buffer?.bytes.length ?? null,
        availability: info ? availabilityWarning(info, programmer) : null,
      })
    : null;

  return (
    <>
      <div className="device-screen" inert={confirm !== null}>
        <div className="device-side">
          <ProgrammerBar
            programmer={state.programmer}
            busy={busy}
            onDetect={controller.detect}
            onChoose={controller.chooseProgrammer}
            algorithms={needsAlgorithmFile(state) ? state.algorithms : undefined}
            algorithmsRestoreError={state.algorithmsRestoreError}
            fileBusy={state.fileBusy !== null}
            onChooseAlgorithms={controller.chooseAlgorithmFile}
            onClearAlgorithms={controller.clearAlgorithmFile}
          />
          <ChipPicker
            chip={state.chip}
            programmer={programmer}
            recent={recent}
            busy={busy}
            onQuery={controller.setQuery}
            onSelect={controller.selectChip}
            onClear={controller.clearChip}
          />
          {footer && <footer className="device-footer">{footer}</footer>}
        </div>
        <main className="device-main">
          <OperationsPanel
            availability={availability}
            running={state.running}
            outcome={state.outcome}
            onRun={controller.run}
            onCancel={controller.requestCancel}
            onRetry={controller.retry}
          />
          <BufferPanel
            buffer={state.buffer}
            unsaved={unsavedBuffer(state.buffer)}
            size={stableSize}
            chip={chipName}
            fileError={state.fileError}
            busy={busy}
            fileBusy={state.fileBusy !== null}
            diff={state.diff}
            inspect={state.inspect}
            onOpen={controller.openFile}
            onSave={controller.save}
            onSaveAs={controller.saveAs}
            onEdit={controller.editBuffer}
            onCloseDiff={controller.closeDiff}
            onInspect={controller.inspect}
            onCancelInspect={controller.cancelInspect}
            onCloseInspect={controller.closeInspect}
          />
          <LogPane log={state.log} onClear={controller.clearLog} />
        </main>
      </div>
      {confirm && (
        <ConfirmDialog
          copy={confirm}
          onConfirm={controller.confirm}
          onCancel={controller.dismissConfirm}
          fallbackFocus={operationsFocus}
        />
      )}
    </>
  );
}
