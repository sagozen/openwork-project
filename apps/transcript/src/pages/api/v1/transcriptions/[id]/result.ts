import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { actorOwnsJob, resolveActor } from "../../../../../lib/api";
import { downloadFormat, getJob } from "../../../../../lib/jobs";
import { runtimeEnv } from "../../../../../lib/runtime";

const FORMATS = new Set(["json", "txt", "srt", "vtt"]);

/**
 * Serves the transcript in one of four formats. The bytes come from R2; the Worker only
 * renders the format on demand, so a client can request any of them without extra storage.
 */
export const GET: APIRoute = async ({ locals, params, request, url }) =>
  handleApi(request, async () => {
    const env = runtimeEnv();
    const actor = await resolveActor(locals, request, "transcriptions:read");
    const job = await getJob(d1Db(env.DB), params.id ?? "");
    if (!job || !actorOwnsJob(actor, job)) throw new HttpError("not_found", 404, "Transcription not found.");
    if (job.status !== "succeeded" || !job.result_key) {
      throw new HttpError("not_found", 404, "This transcription has no result yet.", { status: job.status });
    }
    const format = (url.searchParams.get("format") ?? "json").toLowerCase();
    if (!FORMATS.has(format)) throw new HttpError("invalid_input", 400, "format must be json, txt, srt or vtt.");
    const file = await downloadFormat(env, job, format as "json" | "txt" | "srt" | "vtt");
    if (!file) throw new HttpError("not_found", 404, "The result file is gone.");
    const inline = url.searchParams.get("inline") === "1";
    return new Response(file.body, {
      headers: {
        "content-type": file.contentType,
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${file.filename}"`,
        "cache-control": "private, max-age=300",
      },
    });
  });
