import { useEffect, useId, useRef, type KeyboardEvent, type MouseEvent } from "react";
import type { ConfirmCopy } from "../../lib/device/messages";

export interface ConfirmDialogProps {
  copy: ConfirmCopy;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A modal question with two answers. Backing out is the default: it has
 * the focus when the dialog opens, Escape picks it, and so does a click
 * outside. Tab stays inside the dialog, and the focus goes back to where it
 * was when the dialog closes.
 */
export function ConfirmDialog({ copy, onConfirm, onCancel }: ConfirmDialogProps) {
  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const before = document.activeElement;
    cancelRef.current?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    // Two buttons: Tab and Shift+Tab both go to the other one.
    event.preventDefault();
    const next =
      document.activeElement === cancelRef.current ? confirmRef.current : cancelRef.current;
    next?.focus();
  }

  function onBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) onCancel();
  }

  return (
    <div className="dialog-backdrop" onMouseDown={onBackdropMouseDown}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>{copy.title}</h2>
        <div id={bodyId}>
          {copy.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
        <div className="dialog-buttons">
          <button type="button" ref={cancelRef} onClick={onCancel}>
            {copy.cancel}
          </button>
          <button type="button" ref={confirmRef} className="button-danger" onClick={onConfirm}>
            {copy.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
