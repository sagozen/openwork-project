import { requireAdmin } from "@templatedesign/platform/admin";
import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi, json, readJson } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { presignConfigured, presignR2 } from "../../../../../../lib/r2-presign";
import { runtimeEnv } from "../../../../../../lib/runtime";
import { releaseKey, validReleaseTarget, validReleaseVersion } from "../../../../../../lib/worker-releases";

/**
 * `POST /api/v1/admin/workers/releases/upload-url` — mints a presigned PUT so the browser sends
 * the executable straight to R2. The Worker then verifies the metadata and records the release.
 */
export const POST: APIRoute = async ({ locals, request }) =>
  handleApi(request, async () => {
    const env = runtimeEnv();
    const db = d1Db(env.DB);
    await requireAdmin(db, locals.user, env, "admin");
    if (!presignConfigured(env)) {
      throw new HttpError("dependency_unavailable", 503, "R2 presigning is not configured on this deployment.");
    }
    const body = await readJson<{ version?: string; platform?: string; arch?: string }>(request);
    const version = (body.version ?? "").trim();
    const platform = (body.platform ?? "windows").trim();
    const arch = (body.arch ?? "amd64").trim();
    if (!validReleaseVersion(version) || !validReleaseTarget(platform, arch)) {
      throw new HttpError("invalid_input", 400, "Invalid version, platform or arch.");
    }
    const key = releaseKey(version, platform, arch);
    const url = await presignR2(env, {
      bucket: "outputs",
      key,
      method: "PUT",
      expiresIn: 1800,
    });
    return json({ key, url, expiresInSeconds: 1800 });
  });
