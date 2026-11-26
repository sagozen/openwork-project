import type { Db } from "@templatedesign/platform/db";
import { serviceFor } from "../http/shared.js";
import { otaRuntime } from "./ota-runtime";
import type { Env } from "./types";

const SWEEP_PAGE = 100;

interface SweepResult {
  workspaces: number;
  removed: number;
  failed: number;
}

/**
 * Retention sweep. Each workspace is pruned with its own retention window (its saved choice, or the
 * deployment default narrowed by its plan) and its own storage, one workspace at a time so a
 * failing bucket in one workspace never blocks the others.
 */
export async function sweepExpiredBuilds(db: Db, env: Env): Promise<SweepResult> {
  const result: SweepResult = { workspaces: 0, removed: 0, failed: 0 };
  let after = "";
  for (;;) {
    const page = await db.all<{ id: string; slug: string; plan: string }>(
      "SELECT id, slug, plan FROM workspaces WHERE app = 'ota' AND id > ? ORDER BY id LIMIT ?",
      [after, SWEEP_PAGE],
    );
    if (page.length === 0) break;
    for (const workspace of page) {
      result.workspaces += 1;
      try {
        const runtime = await otaRuntime({ env, db, workspace });
        result.removed += await serviceFor(runtime, null).service.purgeExpired();
      } catch (error) {
        result.failed += 1;
        console.error(
          JSON.stringify({
            evt: "ota_sweep_failed",
            workspace: workspace.id,
            error: error instanceof Error ? error.name : "unknown",
          }),
        );
      }
    }
    after = page[page.length - 1].id;
    if (page.length < SWEEP_PAGE) break;
  }
  return result;
}
