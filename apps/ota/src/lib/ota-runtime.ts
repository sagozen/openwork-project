import type { Db } from "@templatedesign/platform/db";
import { entitlementLimit, UNLIMITED, type Workspace } from "@templatedesign/platform/workspaces";
import { DEFAULT_MAX_BUNDLE_BYTES } from "../domain/data.js";
import type { OtaRuntime } from "../http/shared.js";
import { mediaPlatformStorage, workspaceMediaPrefix } from "../storage/media.js";
import type { Env } from "./types";

const BYTES_PER_MB = 1024 * 1024;
/** The multipart reader holds a bundle in memory, so no configuration may exceed this. */
const HARD_MAX_BUNDLE_BYTES = 512 * BYTES_PER_MB;

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export type OtaWorkspace = Pick<Workspace, "id" | "plan" | "slug">;

/**
 * Builds the runtime one workspace's OTA service runs with: its own storage prefix, its own
 * bundle ceiling (the deployment limit narrowed by the plan) and its public URL. Used by the
 * routes and by the retention sweep, so both apply the same limits.
 */
export async function otaRuntime(input: {
  env: Env;
  db: Db;
  workspace: OtaWorkspace;
  /** Origin the request arrived on; falls back to the configured app origin. */
  origin?: string;
}): Promise<OtaRuntime> {
  const { env, db, workspace } = input;
  const planMb = await entitlementLimit(db, workspace, "bundle.maxMb");
  const deployment = positiveInt(env.OTA_MAX_BUNDLE_BYTES) ?? DEFAULT_MAX_BUNDLE_BYTES;
  const plan = planMb === UNLIMITED || planMb <= 0 ? Number.POSITIVE_INFINITY : planMb * BYTES_PER_MB;
  const maxBundleBytes = Math.min(deployment, plan, HARD_MAX_BUNDLE_BYTES);
  const origin = (input.origin ?? env.APP_ORIGIN ?? "").replace(/\/$/, "");
  const retentionDays = positiveInt(env.OTA_RETENTION_DAYS);
  return {
    db,
    workspace,
    platform: env.MEDIA ? mediaPlatformStorage(env.MEDIA, workspaceMediaPrefix(workspace.id)) : null,
    secretKey: env.OTA_SECRET_KEY?.trim() || null,
    baseUrl: `${origin}/${workspace.slug}`,
    mountPath: `/${workspace.slug}/ota`,
    maxBundleBytes,
    ...(retentionDays === undefined ? {} : { retentionDays }),
  };
}
