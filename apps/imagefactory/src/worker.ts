import { handle } from "@astrojs/cloudflare/handler";
import "./lib/platform";
import { purgeExpiredImages, runDailyCron, runSweep } from "./lib/ops";
import type { Env } from "./lib/types";

const SWEEP_CRON = "*/5 * * * *";
const HOURLY_CRON = "0 * * * *";
const DAILY_CRON = "20 3 * * *";

/**
 * Custom Worker entry: the Astro handler plus the cron triggers declared in `wrangler.jsonc`.
 * The five-minute tick settles or fails image jobs the provider never reported on. The hourly
 * tick removes files of images deleted more than 30 days ago. The daily tick sends the spend
 * digest and runs the same file removal again.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return handle(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        try {
          if (controller.cron === SWEEP_CRON) {
            console.log(JSON.stringify({ evt: "sweep_cron", ...(await runSweep(env)) }));
            return;
          }
          if (controller.cron === HOURLY_CRON) {
            console.log(
              JSON.stringify({
                evt: "hourly_cron",
                imagesPurged: await purgeExpiredImages(env, controller.scheduledTime),
              }),
            );
            return;
          }
          if (controller.cron === DAILY_CRON) {
            console.log(JSON.stringify({ evt: "daily_cron", ...(await runDailyCron(env, controller.scheduledTime)) }));
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
