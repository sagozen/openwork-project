import { handle } from "@astrojs/cloudflare/handler";
import "./lib/platform";
import { runDailyCron, runHourlyCron } from "./lib/ops";
import type { Env } from "./lib/types";

const HOURLY_CRON = "0 * * * *";
const DAILY_CRON = "20 3 * * *";

/**
 * Custom Worker entry: the Astro handler plus the cron triggers declared in `wrangler.jsonc`. The
 * hourly tick deletes expired files and abandoned uploads (500 of each at most). The daily tick,
 * at 03:20 UTC, retries failed emails and sends the operators the storage digest.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return handle(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        try {
          if (controller.cron === HOURLY_CRON) {
            console.log(JSON.stringify({ evt: "hourly_cron", ...(await runHourlyCron(env)) }));
            return;
          }
          if (controller.cron === DAILY_CRON) {
            const { digest, emails, emailed } = await runDailyCron(env, new Date(controller.scheduledTime));
            console.log(
              JSON.stringify({ evt: "daily_cron", emails, emailed, files: digest.files, bytes: digest.bytes }),
            );
            return;
          }
          console.warn(JSON.stringify({ evt: "unknown_cron", cron: controller.cron }));
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
