import { json } from "@templatedesign/platform/http";
import { waitUntil } from "@templatedesign/platform/runtime";
import type { APIRoute } from "astro";
import { runAddons } from "../../../../../../lib/addons/summary";
import { completeJob, getJob, mapJob, type ProbeResult, parseJson } from "../../../../../../lib/jobs";
import type { JobOptions } from "../../../../../../lib/pricing";
import type { StoredTranscript } from "../../../../../../lib/transcripts";
import { jobIdFrom, withWorker, workerJson } from "../../_context";

interface CompleteBody {
  stage?: "probe" | "transcribe";
  lease_token?: string;
  probe?: ProbeResult;
  transcript_key?: string;
  formats?: string[];
  language?: string;
  model?: string;
}

/**
 * `POST …/complete` — idempotent. The Worker accepts only the first `leased → succeeded`
 * transition, so a worker whose lease expired (and whose job was requeued) is rejected here
 * and never charges the account. A summary add-on is scheduled with `waitUntil` after the
 * transcript is safely stored.
 */
export const POST: APIRoute = async (context) =>
  withWorker(context, async ({ env, db, worker }) => {
    const body = await workerJson<CompleteBody>(context);
    const jobId = jobIdFrom(context);
    const stage = body.stage === "probe" ? "probe" : "transcribe";

    if (stage === "probe") {
      if (!body.probe || !Number.isFinite(Number(body.probe.durationSeconds))) {
        return json({ accepted: false, reason: "missing_probe" }, { status: 400 });
      }
      const result = await completeJob(
        env,
        db,
        worker.id,
        jobId,
        {
          stage: "probe",
          probe: { ...body.probe, durationSeconds: Number(body.probe.durationSeconds) },
        },
        body.lease_token ?? null,
      );
      return json(result, { status: result.accepted ? 200 : 409 });
    }

    const transcript = (body as CompleteBody & { transcript?: StoredTranscript }).transcript;
    const result = await completeJob(
      env,
      db,
      worker.id,
      jobId,
      {
        stage: "transcribe",
        transcriptKey: body.transcript_key,
        transcript,
        formats: body.formats,
        language: body.language,
        model: body.model,
      },
      body.lease_token ?? null,
    );
    if (!result.accepted) return json(result, { status: 409 });

    const job = await getJob(db, jobId);
    if (job) {
      const options = parseJson<JobOptions>(job.options_json, {});
      if (options.summary) {
        waitUntil(
          runAddons(env, db, jobId).catch((error) => {
            console.error(JSON.stringify({ evt: "addon_failed", job: jobId, error: String(error).slice(0, 200) }));
          }),
        );
      }
      return json({ accepted: true, job: mapJob(job) });
    }
    return json({ accepted: true });
  });
