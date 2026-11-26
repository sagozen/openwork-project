import { d1Db } from "@templatedesign/platform/db";
import { handleApi, json, readJson } from "@templatedesign/platform/http";
import { takeRateLimit } from "@templatedesign/platform/rate-limit";
import type { APIRoute } from "astro";
import { resolveActor } from "../../../../lib/api";
import { assertNotBlocked, countRateLimited, requestAbuseSubjects } from "../../../../lib/job-abuse";
import { runtimeEnv } from "../../../../lib/runtime";
import { createUpload } from "../../../../lib/uploads";

interface UploadBody {
  filename?: unknown;
  content_type?: unknown;
  size?: unknown;
}

/**
 * Returns one presigned R2 PUT. The browser uploads directly, then calls
 * `POST /api/v1/transcriptions` with `upload_id`.
 */
export const POST: APIRoute = async ({ locals, request }) =>
  handleApi(request, async () => {
    const env = runtimeEnv();
    const db = d1Db(env.DB);
    const actor = await resolveActor(locals, request, "transcriptions:write");
    const subjects = requestAbuseSubjects(actor, request);
    await assertNotBlocked(db, subjects);
    const body = await readJson<UploadBody>(request);
    const filename = typeof body.filename === "string" ? body.filename : "";
    const contentType = typeof body.content_type === "string" ? body.content_type : "";
    const size = Number(body.size);
    await countRateLimited(env, db, subjects, () =>
      takeRateLimit(db, `upload:${actor.tenantId ?? actor.guestId}`, 60, 3600),
    );
    const session = await createUpload(env, db, {
      tenantId: actor.tenantId,
      guestId: actor.guestId,
      filename: filename || "upload",
      contentType,
      sizeBytes: size,
    });
    return json(
      {
        upload_id: session.id,
        url: session.url,
        method: "PUT",
        content_type: session.contentType,
        expires_in_seconds: session.expiresInSeconds,
        max_bytes: session.maxBytes,
      },
      { status: 201 },
    );
  });
