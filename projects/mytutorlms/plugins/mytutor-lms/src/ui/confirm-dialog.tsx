import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  /**
   * Destructive actions start with focus on Cancel, others on Confirm; with
   * a typed or reason field, focus starts in the first field.
   */
  tone?: "default" | "danger";
  /** Asks for a written reason, kept in the audit log by the caller. */
  reason?: {
    label: string;
    hint?: string;
    minLength: number;
    /** The server's limit; the field stops there. */
    maxLength?: number;
    error: string;
  };
  /** Asks the person to type a value (an email, a course name) to confirm. */
  typed?: { label: string; expected: string; error: string };
}

export interface ConfirmResult {
  reason: string;
  typed: string;
}

export type Confirm = (
  options: ConfirmOptions,
) => Promise<ConfirmResult | null>;

/**
 * Replaces window.confirm and window.prompt with an accessible modal on the
 * native <dialog>: the rest of the page is inert while it is open, Esc
 * cancels, and focus returns to the control that opened it.
 *
 * `confirm()` resolves to null when cancelled, otherwise to the trimmed
 * reason and typed value ("" when not asked for). Render the returned
 * element once.
 */
export function useConfirmDialog(): [Confirm, ReactElement | null] {
  const [request, setRequest] = useState<{
    id: number;
    options: ConfirmOptions;
    resolve: (value: ConfirmResult | null) => void;
  } | null>(null);
  const nextId = useRef(0);
  const pending = useRef(request);
  pending.current = request;
  // A screen that goes away with its question open never acts on the answer.
  useEffect(() => () => pending.current?.resolve(null), []);
  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<ConfirmResult | null>((resolve) =>
        setRequest((current) => {
          // A second request while one is open cancels the first.
          current?.resolve(null);
          return { id: ++nextId.current, options, resolve };
        }),
      ),
    [],
  );
  const element = request ? (
    <ConfirmDialog
      key={request.id}
      options={request.options}
      onClose={(value) => {
        request.resolve(value);
        setRequest(null);
      }}
    />
  ) : null;
  return [confirm, element];
}

function ConfirmDialog({
  options,
  onClose,
}: {
  options: ConfirmOptions;
  onClose: (value: ConfirmResult | null) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [typed, setTyped] = useState("");
  const [typedError, setTypedError] = useState("");
  // Closing on the backdrop needs the press to start there too, so a text
  // selection dragged out of a field never discards what was typed.
  const pressedBackdrop = useRef(false);
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (!dialog.current?.open) dialog.current?.showModal();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  const danger = options.tone === "danger";
  return (
    <dialog
      ref={dialog}
      className="mt-dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={options.body ? `${id}-body` : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose(null);
      }}
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === dialog.current;
      }}
      onClick={(event) => {
        if (event.target === dialog.current && pressedBackdrop.current)
          onClose(null);
      }}
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const value = reason.trim();
          const typedValue = typed.trim();
          const typedOk =
            !options.typed ||
            typedValue.toLowerCase() === options.typed.expected.toLowerCase();
          const reasonOk =
            !options.reason || value.length >= options.reason.minLength;
          if (!typedOk) setTypedError(options.typed!.error);
          if (!reasonOk) setError(options.reason!.error);
          if (typedOk && reasonOk)
            onClose({ reason: value, typed: typedValue });
        }}
      >
        <h2 id={`${id}-title`}>{options.title}</h2>
        {options.body && (
          <div id={`${id}-body`} className="mt-dialog-body">
            {options.body}
          </div>
        )}
        {options.typed && (
          <label className="mt-dialog-field">
            <span>{options.typed.label}</span>
            <input
              value={typed}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              aria-invalid={typedError ? true : undefined}
              aria-describedby={typedError ? `${id}-typed-error` : undefined}
              onChange={(event) => {
                setTyped(event.target.value);
                setTypedError("");
              }}
            />
            {typedError && (
              <small id={`${id}-typed-error`} className="mt-dialog-error">
                {typedError}
              </small>
            )}
          </label>
        )}
        {options.reason && (
          <label className="mt-dialog-field">
            <span>{options.reason.label}</span>
            {options.reason.hint && (
              <small id={`${id}-hint`}>{options.reason.hint}</small>
            )}
            <textarea
              rows={3}
              maxLength={options.reason.maxLength}
              value={reason}
              autoFocus={!options.typed}
              aria-invalid={error ? true : undefined}
              aria-describedby={
                [options.reason.hint && `${id}-hint`, error && `${id}-error`]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              onChange={(event) => {
                setReason(event.target.value);
                setError("");
              }}
            />
            {error && (
              <small id={`${id}-error`} className="mt-dialog-error">
                {error}
              </small>
            )}
          </label>
        )}
        <div className="mt-dialog-actions">
          <button
            type="button"
            className="button secondary"
            autoFocus={danger && !options.reason && !options.typed}
            onClick={() => onClose(null)}
          >
            {options.cancelLabel}
          </button>
          <button
            type="submit"
            className={`button mt-primary${danger ? " danger mt-danger" : ""}`}
            autoFocus={!danger && !options.reason && !options.typed}
          >
            {options.confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
