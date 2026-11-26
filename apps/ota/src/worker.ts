import { handle } from "@astrojs/cloudflare/handler";
import { d1Db } from "@templatedesign/platform/db";
import { expireWorkspacePlans } from "@templatedesign/platform/workspaces";
import "./lib/platform";
import { sweepExpiredBuilds } from "./lib/sweep";
import type { Env } from "./lib/types";

/** Custom Worker entry: the Astro handler plus the daily retention cron declared in wrangler.jsonc. */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return handle(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        const expiredPlans = await expireWorkspacePlans(d1Db(env.DB));
        const result = await sweepExpiredBuilds(d1Db(env.DB), env);
        console.log(JSON.stringify({ evt: "daily_cron", cron: controller.cron, expiredPlans, ...result }));
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
