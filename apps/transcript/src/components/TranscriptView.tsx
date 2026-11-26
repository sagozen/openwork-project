import { Badge, Button, InlineNotice, LinkButton, TextInput, track } from "@templatedesign/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AddonState, NormalizedTranscript } from "../lib/transcripts";

export interface TranscriptViewProps {
  locale: "en" | "vi";
  jobId: string;
  title: string;
  sourceKind: string;
  durationSeconds: number | null;
  language: string | null;
  model: string | null;
  mediaUrl: string | null;
  transcript: NormalizedTranscript;
  addons: AddonState | null;
  credits: number;
  /** Rendered inside the landing page, which already owns the page heading. */
  embedded?: boolean;
}

function timeLabel(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/**
 * Transcript reader: sticky player (uploaded media), click-to-seek timestamps, optional
 * word highlighting, search, the summary/filter panel and the export row.
 */
export function TranscriptView({
  locale,
  jobId,
  title,
  sourceKind,
  durationSeconds,
  language,
  model,
  mediaUrl,
  transcript,
  addons: initialAddons,
  credits,
  embedded = false,
}: TranscriptViewProps) {
  const vi = locale === "vi";
  const Heading = embedded ? "h2" : "h1";
  const Subheading = embedded ? "h3" : "h2";
  const [query, setQuery] = useState("");
  const [highlightWords, setHighlightWords] = useState(false);
  const [addons, setAddons] = useState<AddonState | null>(initialAddons);
  const [copied, setCopied] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);

  // The summary runs after the transcript is delivered; poll until it settles.
  useEffect(() => {
    if (addons?.status !== "pending") return;
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/v1/transcriptions/${jobId}`).catch(() => null);
      if (!response?.ok) return;
      const body = (await response.json()) as { transcription: { addons: AddonState | null } };
      const next = body.transcription.addons;
      if (next && next.status !== "pending") setAddons(next);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [addons, jobId]);

  const segments = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const withIndex = transcript.segments.map((segment, index) => ({ ...segment, index }));
    if (!needle) return withIndex;
    return withIndex.filter((segment) => segment.text.toLowerCase().includes(needle));
  }, [query, transcript.segments]);

  const seek = (seconds: number) => {
    setCurrentTime(seconds);
    if (audio.current) {
      audio.current.currentTime = seconds;
      void audio.current.play().catch(() => undefined);
    }
  };

  const plainText = transcript.segments
    .map((segment) => segment.text.trim())
    .join(" ")
    .replace(/\s+/g, " ");

  const copyAll = async () => {
    await navigator.clipboard?.writeText(plainText);
    setCopied(true);
    track("transcript_copied", { job: jobId });
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="ta-transcript">
      <header className="ta-transcript__header">
        <div>
          <Heading>{title}</Heading>
          <p className="ta-transcript__meta">
            {durationSeconds ? timeLabel(durationSeconds) : null}
            {language ? ` · ${language.toUpperCase()}` : null}
            {model ? ` · ${model}` : null}
            {sourceKind ? ` · ${sourceKind}` : null}
            {transcript.word_timestamps ? ` · ${vi ? "có mốc thời gian từng từ" : "word timestamps"}` : null}
          </p>
        </div>
        <div className="ta-transcript__actions">
          <Button variant="secondary" size="sm" iconLeft="copy" onClick={copyAll}>
            {copied ? (vi ? "Đã sao chép" : "Copied") : vi ? "Sao chép" : "Copy"}
          </Button>
        </div>
      </header>

      {mediaUrl ? (
        <div className="ta-transcript__player">
          {/* biome-ignore lint/a11y/useMediaCaption: transcript below is the caption track */}
          <audio
            ref={audio}
            src={mediaUrl}
            controls
            preload="none"
            onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          />
        </div>
      ) : null}

      <div className="ta-transcript__toolbar">
        <TextInput
          aria-label={vi ? "Tìm trong bản ghi" : "Search the transcript"}
          placeholder={vi ? "Tìm trong bản ghi…" : "Search the transcript…"}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {transcript.word_timestamps ? (
          <Button
            variant={highlightWords ? "primary" : "tertiary"}
            size="sm"
            onClick={() => setHighlightWords((value) => !value)}
          >
            {vi ? "Tô từng từ" : "Highlight words"}
          </Button>
        ) : null}
      </div>

      <ol className="ta-transcript__segments">
        {segments.map((segment) => {
          const isCurrent = mediaUrl && currentTime >= segment.start && currentTime < segment.end;
          return (
            <li key={segment.index} className={isCurrent ? "is-current" : undefined}>
              <button type="button" className="ta-transcript__time" onClick={() => seek(segment.start)}>
                {timeLabel(segment.start)}
              </button>
              <p>
                {highlightWords && segment.words?.length
                  ? segment.words.map((word, index) => (
                      <span
                        key={index}
                        className={currentTime >= word.start && currentTime < word.end ? "is-speaking" : undefined}
                      >
                        {word.word}{" "}
                      </span>
                    ))
                  : segment.text}
              </p>
            </li>
          );
        })}
      </ol>

      <section className="ta-transcript__exports" aria-label={vi ? "Tải xuống" : "Downloads"}>
        <Subheading>{vi ? "Tải xuống" : "Download"}</Subheading>
        <div className="ta-transcript__exportrow">
          {["txt", "srt", "vtt", "json"].map((format) => (
            <LinkButton
              key={format}
              href={`/api/v1/transcriptions/${jobId}/result?format=${format}`}
              variant="secondary"
              size="sm"
              iconLeft="download"
            >
              {format.toUpperCase()}
            </LinkButton>
          ))}
        </div>
      </section>

      {addons ? (
        <section className="ta-transcript__addons" aria-label={vi ? "Tóm tắt" : "Summary"}>
          <Subheading>{vi ? "Tóm tắt & lọc" : "Summary & filter"}</Subheading>
          {addons.status === "pending" ? (
            <p className="ta-muted">{vi ? "Đang tạo tóm tắt…" : "Writing the summary…"}</p>
          ) : addons.status === "failed" ? (
            <InlineNotice tone="info" title={vi ? "Không tạo được tóm tắt" : "Summary unavailable"}>
              {vi
                ? "Bản ghi đã sẵn sàng; credit của phần tóm tắt đã được hoàn lại."
                : "Your transcript is ready and the add-on credits were released."}
            </InlineNotice>
          ) : addons.filtered ? (
            <ol className="ta-transcript__segments">
              {addons.filtered.map((item) => (
                <li key={item.start}>
                  <button type="button" className="ta-transcript__time" onClick={() => seek(item.start)}>
                    {timeLabel(item.start)}
                  </button>
                  <p>{item.text}</p>
                </li>
              ))}
            </ol>
          ) : (
            <div className="ta-transcript__summary">
              {addons.summary?.split("\n").map((line, index) => (
                <p key={index}>{line}</p>
              ))}
              {addons.model ? <p className="ta-muted">{addons.model}</p> : null}
            </div>
          )}
        </section>
      ) : null}

      {credits < 0 ? <Badge tone="warning">{vi ? "Số dư âm" : "Negative balance"}</Badge> : null}
    </div>
  );
}
