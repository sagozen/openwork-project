import { useEffect, useState, useSyncExternalStore } from "react";
import { Icon } from "./icon.js";
import type { Tone } from "./inline-alert.js";

// Short confirmations of something the person just did ("Lesson saved").
// Errors that need action stay inline (InlineAlert), never in a toast.
interface ToastMessage {
  id: number;
  tone: Exclude<Tone, "danger">;
  text: string;
}
let messages: ToastMessage[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function showToast(
  text: string,
  tone: ToastMessage["tone"] = "success",
): void {
  messages = [...messages.slice(-2), { id: nextId++, tone, text }];
  emit();
}

function dismiss(id: number) {
  messages = messages.filter((message) => message.id !== id);
  emit();
}

/** Render once per island. Messages stay 6 seconds, longer while hovered. */
export function ToastRegion({ dismissLabel }: { dismissLabel: string }) {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => messages,
    () => messages,
  );
  return (
    <div className="mt-toasts" role="status" aria-live="polite">
      {current.map((message) => (
        <Toast key={message.id} message={message} dismissLabel={dismissLabel} />
      ))}
    </div>
  );
}

function Toast({
  message,
  dismissLabel,
}: {
  message: ToastMessage;
  dismissLabel: string;
}) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const timer = window.setTimeout(() => dismiss(message.id), 6000);
    return () => window.clearTimeout(timer);
  }, [paused, message.id]);
  return (
    <div
      className={`mt-toast mt-toast-${message.tone}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon name={message.tone === "success" ? "circle-check" : "info"} />
      <p>{message.text}</p>
      <button
        type="button"
        className="mt-icon-button"
        aria-label={dismissLabel}
        onClick={() => dismiss(message.id)}
      >
        <Icon name="x" size={16} />
      </button>
    </div>
  );
}
