import { Button } from "@templatedesign/ui";
import { useState } from "react";

/** Copies `value` to the clipboard and says so for a moment. */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Button variant="secondary" size="sm" onClick={copy} aria-live="polite">
      {copied ? "Copied" : label}
    </Button>
  );
}
