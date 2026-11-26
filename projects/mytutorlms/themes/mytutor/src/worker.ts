import handler, { createScheduledHandler } from "@emdash-cms/cloudflare/worker";
import { setAnalyticsSink, type AnalyticsSink } from "./lib/analytics-sink";

type Env = { MYTUTOR_EVENTS?: AnalyticsSink };
type Fetch = (
  request: Request,
  env: Env,
  context: unknown,
) => Promise<Response>;

export default {
  ...handler,
  // The optional Analytics Engine binding receives /api/events (UX telemetry).
  fetch(request: Request, env: Env, context: unknown) {
    setAnalyticsSink(env.MYTUTOR_EVENTS ?? null);
    return (handler.fetch as unknown as Fetch)(request, env, context);
  },
  scheduled: createScheduledHandler(),
};
