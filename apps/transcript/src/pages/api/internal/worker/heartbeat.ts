import { json } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { PRICING } from "../../../../lib/pricing";
import { updateManifestFor } from "../../../../lib/worker-releases";
import {
  heartbeat,
  mapWorker,
  type WorkerCapabilities,
  type WorkerHeartbeatInput,
  type WorkerRow,
  workerConfigFor,
} from "../../../../lib/workers";
import { withWorker, workerJson } from "./_context";

/**
 * `POST /api/internal/worker/heartbeat` — every 20 s. Carries the host metrics, the applied
 * config version and the updater state; the response is how remote config and a newer release
 * reach the machine. A release-manifest failure here must never fail the heartbeat itself.
 */
export const POST: APIRoute = async (context) =>
  withWorker(context, async ({ env, db, worker }) => {
    const body = await workerJson<WorkerHeartbeatInput & { capabilities?: WorkerCapabilities }>(context);
    await heartbeat(db, worker, {
      version: body.version,
      capabilities: body.capabilities,
      configVersion: body.configVersion,
      metrics: body.metrics,
      update: body.update,
      activeJobs: body.activeJobs,
    });

    const fresh = (await db.first<WorkerRow>("SELECT * FROM workers WHERE id = ?", [worker.id])) ?? worker;
    const configVersion = fresh.config_version ?? 0;
    const capabilities = body.capabilities ?? {};
    const currentVersion = body.version ?? fresh.version ?? "0.0.0";

    let update = null;
    try {
      update = await updateManifestFor(env, db, {
        platform: capabilities.platform ?? "windows",
        arch: capabilities.arch ?? "amd64",
        currentVersion,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          evt: "worker_update_manifest_failed",
          worker: worker.id,
          error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
        }),
      );
    }

    return json({
      ok: true,
      worker: mapWorker(fresh),
      lease_seconds: PRICING.leaseSeconds,
      server_time: new Date().toISOString(),
      config_version: configVersion,
      // Version 0 means "never configured": the worker keeps its environment values.
      config: configVersion > 0 ? workerConfigFor(fresh) : null,
      update,
    });
  });
