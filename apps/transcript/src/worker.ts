import { handle } from "@astrojs/cloudflare/handler";
import { reconcileCrm, runUsageDigest } from "@templatedesign/platform/crm";
import { d1Db } from "@templatedesign/platform/db";
import "./lib/platform";
import { runDailyCron, runMinuteCron } from "./lib/ops";
import type { Env } from "./lib/types";

/**
 * Custom Worker entry: the Astro handler plus the cron triggers declared in `wrangler.jsonc`:
 * every 5 minutes for lease recovery and alerts, every 6 hours (minute 0 of hours 0, 6, 12 and
 * 18 UTC) for the usage report email, and once a day for retention, delivery retries, account
 * deletion and payment reconciliation.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return handle(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        try {
          if (controller.cron === "*/5 * * * *") {
            const result = await runMinuteCron(env, controller.scheduledTime);
            console.log(JSON.stringify({ evt: "minute_cron", ...result }));
            return;
          }
          if (controller.cron === "0 */6 * * *") {
            const db = d1Db(env.DB);
            await reconcileCrm(db);
            const sent = await runUsageDigest(env, db, controller.scheduledTime);
            console.log(JSON.stringify({ evt: "usage_digest_cron", sent }));
            return;
          }
          const result = await runDailyCron(env, controller.scheduledTime);
          console.log(JSON.stringify({ evt: "daily_cron", ...result }));
        } catch (error) {
          console.error(
            JSON.stringify({
              evt: "cron_failed",
              cron: controller.cron,
              error: error instanceof Error ? error.message : "unknown",
            }),
          );
          throw error;
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
