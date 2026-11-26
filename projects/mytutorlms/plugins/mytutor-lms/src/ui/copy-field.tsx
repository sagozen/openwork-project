import { useId, useState } from "react";
import { Icon } from "./icon.js";

/** A read-only value with a copy button; selecting the text also works. */
export function CopyField({
  label,
  value,
  copyLabel,
  copiedLabel,
  mono = false,
}: {
  label: string;
  value: string;
  copyLabel: string;
  copiedLabel: string;
  mono?: boolean;
}) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-copy-field">
      <label htmlFor={id}>{label}</label>
      <div>
        <input
          id={id}
          readOnly
          value={value}
          className={mono ? "mt-mono" : undefined}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button
          type="button"
          className="button secondary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2500);
            } catch {
              document.getElementById(id)?.focus();
            }
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={16} />
          <span aria-live="polite">{copied ? copiedLabel : copyLabel}</span>
        </button>
      </div>
    </div>
  );
}
