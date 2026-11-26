import type { APIRoute } from "astro";
import { fail, readBridgeRequest } from "../../lib/bridge";
import { validEnvelope } from "../../lib/analytics-events";
import { analyticsSink } from "../../lib/analytics-sink";

export const prerender = false;

// Best effort per isolate: a burst limit that stops one client flooding the
// dataset. Anyone can post here, so this is UX telemetry only; business
// numbers never come from it (they are recorded server-side).
const WINDOW_MS = 60_000;
const LIMIT = 120;
const seen = new Map<string, { start: number; count: number }>();

function limited(key: string, now: number, events: number): boolean {
  const entry = seen.get(key);
  if (!entry || now - entry.start > WINDOW_MS) {
    if (seen.size > 5000)
      for (const [address, item] of seen)
        if (now - item.start > WINDOW_MS) seen.delete(address);
    if (seen.size > 5000) return true;
    seen.set(key, { start: now, count: events });
    return events > LIMIT;
  }
  entry.count += events;
  return entry.count > LIMIT;
}

/** Accepts batched UX events (lib/analytics.ts) and writes them to Analytics Engine. */
export const POST: APIRoute = async ({ request, url, clientAddress }) => {
  const read = await readBridgeRequest(request, url, 16_384);
  if ("response" in read) return read.response;
  const events = (read.input as { events?: unknown })?.events;
  if (!Array.isArray(events) || events.length === 0 || events.length > 20)
    return fail(400, "INVALID_INPUT", "Send between 1 and 20 events.");
  const valid = events.map(validEnvelope);
  if (valid.some((item) => item === null))
    return fail(400, "INVALID_INPUT", "An event does not match the contract.");
  let address = "unknown";
  try {
    address = clientAddress;
  } catch {
    // Some adapters cannot tell; fall back to one shared bucket.
  }
  if (limited(address, Date.now(), events.length))
    return fail(429, "RATE_LIMITED", "Too many events. Try again later.");
  const sink = analyticsSink();
  if (!sink) return new Response(null, { status: 204 });
  for (const item of valid) {
    if (!item) continue;
    const props = Object.entries(item.props);
    sink.writeDataPoint({
      indexes: [item.event],
      blobs: [
        item.event,
        item.locale,
        item.device,
        item.route,
        item.sessionId,
        ...props.map(([key, value]) => `${key}=${value}`),
      ].slice(0, 20),
      doubles: [item.ts],
    });
  }
  return new Response(null, { status: 204 });
};
