import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "./icon.js";

/**
 * A modal panel from the start edge (or the bottom on phones) on the native
 * <dialog>. Esc, the scrim and the close button all close it, and focus
 * returns to the control that opened it.
 */
export function Sheet({
  open,
  onClose,
  title,
  closeLabel,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  closeLabel: string;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const id = useId();
  const pressedBackdrop = useRef(false);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      opener.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      element.showModal();
    } else if (!open && element.open) {
      element.close();
      if (opener.current?.isConnected) opener.current.focus();
    }
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="mt-sheet"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === dialog.current;
      }}
      onClick={(event) => {
        if (event.target === dialog.current && pressedBackdrop.current)
          onClose();
      }}
    >
      <div className="mt-sheet-header">
        <h2 id={`${id}-title`}>{title}</h2>
        <button
          type="button"
          className="mt-icon-button"
          aria-label={closeLabel}
          onClick={onClose}
        >
          <Icon name="x" />
        </button>
      </div>
      <div className="mt-sheet-body">{children}</div>
    </dialog>
  );
}
