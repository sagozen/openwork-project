import { HttpError, json } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { getJob } from "../../../../../../lib/jobs";
import { mediaDownloadUrl } from "../../../../../../lib/uploads";
import { jobIdFrom, withWorker } from "../../_context";

/** Signed GET for media the browser uploaded, so the worker can fetch it without credentials. */
export const POST: APIRoute = async (context) =>
  withWorker(context, async ({ env, db, worker }) => {
    const job = await getJob(db, jobIdFrom(context));
    if (!job) throw new HttpError("not_found", 404, "Job not found.");
    if (job.leased_by !== worker.id && job.status !== "queued") {
      throw new HttpError("forbidden", 403, "This job is not leased to this worker.");
    }
    if (job.source_kind !== "upload") {
      throw new HttpError("invalid_input", 400, "Only upload jobs need a signed media URL.");
    }
    return json({ url: await mediaDownloadUrl(env, job.source_ref, 3600), expires_in_seconds: 3600 });
  });
