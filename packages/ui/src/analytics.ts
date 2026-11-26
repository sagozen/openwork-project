import { ANALYTICS_EVENTS, eventPropErrors, isAllowedEvent } from "@templatedesign/contracts";

type Props = Record<string, string | number | boolean | undefined>;

declare global {
  interface Window {
    __tdAnalytics?: (event: string, props: Props) => void;
  }
}

const allowed = new Map(ANALYTICS_EVENTS.map((event) => [event.name, event]));

/**
 * First-party analytics only. Refuses unknown events and undeclared properties
 * at runtime in development, and never sends free-form text.
 */
export function track(name: string, props: Props = {}): void {
  const defined = Object.fromEntries(Object.entries(props).filter(([, value]) => value !== undefined));
  const isDev = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true;
  if (isDev) {
    if (!isAllowedEvent(name)) {
      console.warn(`[analytics] unknown event: ${name}`);
      return;
    }
    const errors = eventPropErrors(name, defined);
    if (errors.length > 0) console.warn(`[analytics] ${errors.join("; ")}`);
  }
  if (!allowed.has(name)) return;
  if (typeof window !== "undefined" && typeof window.__tdAnalytics === "function") {
    window.__tdAnalytics(name, defined);
  }
}
