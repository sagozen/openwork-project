import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { actorOwnsJob, resolveActor } from "../../../../../lib/api";
import { getJob } from "../../../../../lib/jobs";
import { runtimeEnv } from "../../../../../lib/runtime";
import { mediaDownloadUrl } from "../../../../../lib/uploads";

/**
 * Signed redirect to the uploaded media, so the transcript player can seek. Only uploads have
 * a media object; a link job's bytes never existed in our storage.
 */
export const GET: APIRoute = async ({ locals, params, request }) =>
  handleApi(request, async () => {
    const env = runtimeEnv();
    const actor = await resolveActor(locals, request, "transcriptions:read");
    const job = await getJob(d1Db(env.DB), params.id ?? "");
    if (!job || !actorOwnsJob(actor, job)) throw new HttpError("not_found", 404, "Transcription not found.");
    if (job.source_kind !== "upload") throw new HttpError("not_found", 404, "This transcript has no media file.");
    const url = await mediaDownloadUrl(env, job.source_ref, 900);
    return new Response(null, { status: 302, headers: { location: url, "cache-control": "private, max-age=600" } });
  });
