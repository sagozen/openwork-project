import type { Db } from "@templatedesign/platform/db";
import type { ApiLocals } from "./api";
import { canViewJob } from "./job-owner";
import { getJob, type JobView, loadTranscript, mapJob } from "./jobs";
import type { NormalizedTranscript } from "./transcripts";
import type { Env } from "./types";

export interface OwnedJob {
  job: JobView;
  transcript: NormalizedTranscript | null;
  mediaUrl: string | null;
}

/** The job plus its transcript when it belongs to the visitor; `null` otherwise (never leaks existence). */
export async function loadJobForVisitor(env: Env, db: Db, locals: ApiLocals, jobId: string): Promise<OwnedJob | null> {
  const row = await getJob(db, jobId);
  if (!row || !canViewJob(locals, row)) return null;
  const transcript = row.status === "succeeded" ? await loadTranscript(env, row) : null;
  return {
    job: mapJob(row),
    transcript,
    mediaUrl: row.source_kind === "upload" ? `/api/v1/transcriptions/${row.id}/media` : null,
  };
}
