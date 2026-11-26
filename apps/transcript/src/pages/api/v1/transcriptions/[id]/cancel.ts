import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi, json } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { actorOwnsJob, resolveActor } from "../../../../../lib/api";
import { cancelJob, getJob, mapJob } from "../../../../../lib/jobs";
import { runtimeEnv } from "../../../../../lib/runtime";

/** Cancel is idempotent: a finished job returns its current state unchanged. */
export const POST: APIRoute = async ({ locals, params, request }) =>
  handleApi(request, async () => {
    const env = runtimeEnv();
    const db = d1Db(env.DB);
    const actor = await resolveActor(locals, request, "transcriptions:write");
    const job = await getJob(db, params.id ?? "");
    if (!job || !actorOwnsJob(actor, job)) throw new HttpError("not_found", 404, "Transcription not found.");
    await cancelJob(env, db, job);
    const fresh = await getJob(db, job.id);
    return json({ transcription: fresh ? mapJob(fresh) : null });
  });
