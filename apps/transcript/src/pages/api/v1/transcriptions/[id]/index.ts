import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi, json } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { actorOwnsJob, resolveActor } from "../../../../../lib/api";
import { getJob, mapJob } from "../../../../../lib/jobs";
import { runtimeEnv } from "../../../../../lib/runtime";

export const GET: APIRoute = async ({ locals, params, request }) =>
  handleApi(request, async () => {
    const actor = await resolveActor(locals, request, "transcriptions:read");
    const job = await getJob(d1Db(runtimeEnv().DB), params.id ?? "");
    if (!job || !actorOwnsJob(actor, job)) throw new HttpError("not_found", 404, "Transcription not found.");
    return json({ transcription: mapJob(job) });
  });
