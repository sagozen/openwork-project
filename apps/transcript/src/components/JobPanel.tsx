import { Badge, Button, InlineNotice } from "@templatedesign/ui";
import { useEffect, useState } from "react";
import type { OwnedJob } from "../lib/job-access";
import type { JobView } from "../lib/jobs";
import { linkErrorText } from "../lib/link-errors";
import type { NormalizedTranscript } from "../lib/transcripts";
import { TranscriptView } from "./TranscriptView.js";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired"]);
const POLL_MS = 4000;

export interface JobPanelProps {
  locale: "en" | "vi";
  jobId: string;
  /** Server-rendered data for this job, or `null` when it is not the visitor's (or does not exist). */
  initial: OwnedJob | null | undefined;
  credits: number;
  onNew: () => void;
  /** Fires once when the job settles, so the page can refresh the balance and the list. */
  onSettled?: () => void;
}

type Load = { state: "loading" } | { state: "missing" } | { state: "ready"; data: OwnedJob };

async function fetchJob(jobId: string): Promise<OwnedJob | null> {
  const id = encodeURIComponent(jobId);
  const response = await fetch(`/api/v1/transcriptions/${id}`, { headers: { accept: "application/json" } });
  if (response.status === 404 || response.status === 401) return null;
  if (!response.ok) throw new Error(`status ${response.status}`);
  const { transcription: job } = (await response.json()) as { transcription: JobView };
  let transcript: NormalizedTranscript | null = null;
  if (job.status === "succeeded") {
    const result = await fetch(`/api/v1/transcriptions/${id}/result?format=json&inline=1`);
    if (result.ok) transcript = (await result.json()) as NormalizedTranscript;
  }
  return { job, transcript, mediaUrl: job.sourceKind === "upload" ? `/api/v1/transcriptions/${id}/media` : null };
}

/** The result area of the landing page: progress while the job runs, then the transcript. */
export function JobPanel({ locale, jobId, initial, credits, onNew, onSettled }: JobPanelProps) {
  const vi = locale === "vi";
  const [load, setLoad] = useState<Load>(() =>
    initial === undefined ? { state: "loading" } : initial ? { state: "ready", data: initial } : { state: "missing" },
  );
  const [networkError, setNetworkError] = useState(false);

  // Poll until the job settles. Server data counts as the first read when it is already final.
  // biome-ignore lint/correctness/useExhaustiveDependencies: restart only when the job changes
  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    const settledAtStart = initial?.job.status && TERMINAL.has(initial.job.status);
    if (initial === null || settledAtStart) return;

    const tick = async () => {
      try {
        const data = await fetchJob(jobId);
        if (!live) return;
        setNetworkError(false);
        if (!data) {
          setLoad({ state: "missing" });
          return;
        }
        setLoad({ state: "ready", data });
        if (TERMINAL.has(data.job.status)) {
          onSettled?.();
          return;
        }
      } catch {
        if (live) setNetworkError(true);
      }
      if (live) timer = window.setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [jobId]);

  const back = (
    <Button variant="secondary" size="sm" onClick={onNew}>
      {vi ? "Bản ghi mới" : "New transcription"}
    </Button>
  );

  if (load.state === "loading") {
    return (
      <div className="ta-panel" aria-busy="true">
        <p className="ta-muted">{vi ? "Đang tải…" : "Loading…"}</p>
      </div>
    );
  }

  if (load.state === "missing") {
    return (
      <div className="ta-panel">
        <InlineNotice tone="warning" title={vi ? "Không tìm thấy bản ghi" : "Transcription not found"}>
          {vi ? "Bản ghi không tồn tại hoặc thuộc tài khoản khác." : "It does not exist or belongs to another account."}
        </InlineNotice>
        {back}
      </div>
    );
  }

  const { job, transcript, mediaUrl } = load.data;
  const title = job.title ?? job.sourceRef;

  if (transcript) {
    return (
      <div className="ta-result">
        <div className="ta-result__bar">{back}</div>
        <TranscriptView
          locale={locale}
          jobId={job.id}
          title={title}
          sourceKind={job.sourceKind}
          durationSeconds={job.durationSeconds}
          language={transcript.language ?? null}
          model={transcript.model ?? null}
          mediaUrl={mediaUrl}
          transcript={transcript}
          addons={job.addons}
          credits={credits}
          embedded
        />
      </div>
    );
  }

  const failed = job.status === "failed" || job.status === "expired" || job.status === "cancelled";
  return (
    <div className="ta-panel" aria-live="polite">
      <h2>{title}</h2>
      <p>
        <Badge tone={failed ? "danger" : job.status === "succeeded" ? "success" : "info"}>
          {failed
            ? vi
              ? "Lỗi"
              : "Failed"
            : job.status === "succeeded"
              ? vi
                ? "Xong"
                : "Done"
              : vi
                ? "Đang xử lý"
                : "In progress"}
        </Badge>
      </p>
      {job.status === "succeeded" ? (
        <InlineNotice tone="warning">
          {vi
            ? "Bản ghi đã xong nhưng chưa tải được. Hãy tải lại trang."
            : "Done, but it could not be loaded. Reload the page."}
        </InlineNotice>
      ) : failed ? (
        <InlineNotice tone="danger" title={vi ? "Không bóc băng được" : "Transcription failed"}>
          {linkErrorText(job.errorCode ?? "source_unavailable", job.sourceKind as never, locale)}
        </InlineNotice>
      ) : (
        <p className="ta-muted">
          {vi ? "Đang bóc băng. Kết quả hiện ở đây khi xong." : "Transcribing. The result appears here."}
        </p>
      )}
      {networkError ? (
        <p className="ta-muted">{vi ? "Mất kết nối, đang thử lại…" : "Connection lost, retrying…"}</p>
      ) : null}
      {back}
    </div>
  );
}
