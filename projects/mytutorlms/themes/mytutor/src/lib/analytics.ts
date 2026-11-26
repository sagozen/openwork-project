import type { UiLocale } from "../i18n";
import type { EventEnvelope, EventName, EventProps } from "./analytics-events";

// First-party UX telemetry. No cookies: the session id lives in this tab's
// sessionStorage. Nothing is sent when the browser asks not to be tracked.
const queue: EventEnvelope[] = [];
let timer: number | undefined;

function disabled(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return nav.doNotTrack === "1" || nav.globalPrivacyControl === true;
}

function sessionId(): string {
  try {
    let id = sessionStorage.getItem("mytutor-ux");
    if (!id) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      sessionStorage.setItem("mytutor-ux", id);
    }
    return id;
  } catch {
    return "0".repeat(32);
  }
}

const device = (): EventEnvelope["device"] =>
  window.innerWidth < 768
    ? "phone"
    : window.innerWidth < 1024
      ? "tablet"
      : "desktop";

function flush() {
  window.clearTimeout(timer);
  timer = undefined;
  if (!queue.length) return;
  const events = queue.splice(0, 20);
  // keepalive lets the last batch leave while the page is closing.
  void fetch("/api/events", {
    method: "POST",
    keepalive: true,
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-mytutor-request": "1" },
    body: JSON.stringify({ events }),
  }).catch(() => undefined);
}

let listening = false;
export function track(
  event: EventName,
  props: EventProps = {},
  locale: UiLocale = "en",
): void {
  if (typeof window === "undefined" || disabled()) return;
  if (!listening) {
    listening = true;
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
  }
  queue.push({
    event,
    locale,
    device: device(),
    route: window.location.pathname,
    ts: Date.now(),
    sessionId: sessionId(),
    props,
  });
  if (queue.length >= 20) flush();
  else timer ??= window.setTimeout(flush, 5000);
}
