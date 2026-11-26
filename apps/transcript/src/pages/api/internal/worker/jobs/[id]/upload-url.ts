import { HttpError, json } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { getJob } from "../../../../../../lib/jobs";
import { resultKey } from "../../../../../../lib/r2-presign";
import { resultUploadUrl } from "../../../../../../lib/uploads";
import { jobIdFrom, withWorker, workerJson } from "../../_context";

/**
 * `POST …/upload-url` returns a presigned PUT for one result object. Only names inside
 * `results/<jobId>/` are accepted, so a worker cannot overwrite another job's transcript.
 */
export const POST: APIRoute = async (context) =>
  withWorker(context, async ({ env, db, worker }) => {
    const job = await getJob(db, jobIdFrom(context));
    if (!job) throw new HttpError("not_found", 404, "Job not found.");
    if (job.leased_by !== worker.id) throw new HttpError("forbidden", 403, "This job is not leased to this worker.");
    const body = await workerJson<{ name?: string }>(context).catch(() => ({ name: "transcript.json" }));
    const name = (body.name ?? "transcript.json").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60) || "transcript.json";
    const key = resultKey(job.id, name);
    return json({ key, url: await resultUploadUrl(env, key, 3600), expires_in_seconds: 3600 });
  });
