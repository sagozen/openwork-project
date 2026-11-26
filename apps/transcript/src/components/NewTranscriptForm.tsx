import { Badge, Button, Checkbox, Field, InlineNotice, Select, TextInput } from "@templatedesign/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { linkErrorText } from "../lib/link-errors";
import { formatDuration, PRICING, quoteJob } from "../lib/pricing-core";

export interface PreviewItem {
  url: string;
  job_id: string | null;
  kind: string | null;
  title: string | null;
  thumbnail: string | null;
  multi: "playlist" | "folder" | null;
  status: string;
  error: string | null;
}

interface ProbeState {
  durationSeconds: number | null;
  items: Array<{ url: string; title?: string; durationSeconds?: number }>;
  hasCreatorCaptions: boolean;
  failed: string | null;
}

export interface NewTranscriptFormProps {
  locale: "en" | "vi";
  signedIn: boolean;
  credits: number;
  csrfToken: string;
  presetSource?: string;
  variant?: "hero" | "app";
  maxUploadMb?: number;
  /** Present only when the deployment enables Turnstile for guests. */
  turnstileSiteKey?: string;
  /** Called with the new job id; without it the page navigates to `/?job=<id>`. */
  onStarted?: (jobId: string) => void;
  /** Called when the price is above the balance; receives the pasted link so it can be resumed. */
  onTopUp?: (link: string | null) => void;
  onSignIn?: () => void;
}

type Tab = "link" | "upload";

const SUMMARY_PRESETS = ["short", "bullets", "chapters", "qa", "filter"] as const;
type SummaryPreset = (typeof SUMMARY_PRESETS)[number];

/**
 * The product's main interaction: paste a link (or drop a file), see the title immediately
 * and the duration + exact price within seconds, then start one job. Used in the landing hero
 * and as the dashboard's new-transcription panel.
 */
function turnstileToken(): string | undefined {
  const input = document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
  return input?.value || undefined;
}

export function NewTranscriptForm({
  locale,
  signedIn,
  credits,
  csrfToken,
  presetSource = "",
  variant = "hero",
  maxUploadMb = PRICING.maxUploadMbFree,
  turnstileSiteKey,
  onStarted,
  onTopUp,
  onSignIn,
}: NewTranscriptFormProps) {
  const vi = locale === "vi";
  const [tab, setTab] = useState<Tab>("link");
  const [url, setUrl] = useState(presetSource);
  const [preview, setPreview] = useState<PreviewItem | null>(null);
  const [probe, setProbe] = useState<ProbeState>({
    durationSeconds: null,
    items: [],
    hasCreatorCaptions: false,
    failed: null,
  });
  const [checking, setChecking] = useState(false);
  const [selectedItems, setSelectedItems] = useState<Record<string, boolean>>({});
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [language, setLanguage] = useState("auto");
  const [wordTimestamps, setWordTimestamps] = useState(false);
  const [useCaptions, setUseCaptions] = useState(true);
  const [summaryPreset, setSummaryPreset] = useState<SummaryPreset | "none">("none");
  const [summaryInstruction, setSummaryInstruction] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileDuration, setFileDuration] = useState<number | null>(null);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsHumanCheck = !signedIn && Boolean(turnstileSiteKey);
  const pollTimer = useRef<number | null>(null);
  const turnstileBox = useRef<HTMLDivElement | null>(null);

  // The Turnstile script only scans the page once; a form mounted later renders its widget itself.
  useEffect(() => {
    const box = turnstileBox.current;
    const api = (window as { turnstile?: { render: (element: HTMLElement) => unknown } }).turnstile;
    if (box && api && box.childElementCount === 0) api.render(box);
  }, []);

  const captionOffer = probe.hasCreatorCaptions && !preview?.multi;
  const options = useMemo(
    () => ({
      language: language === "auto" ? undefined : language,
      word_timestamps: wordTimestamps,
      // Only sent once the probe confirmed captions exist; otherwise the server default applies.
      use_creator_captions: captionOffer ? useCaptions : undefined,
      summary:
        summaryPreset === "none"
          ? null
          : {
              preset: summaryPreset,
              instruction: summaryPreset === "filter" ? summaryInstruction : undefined,
            },
    }),
    [language, wordTimestamps, useCaptions, captionOffer, summaryPreset, summaryInstruction],
  );

  const durationForQuote = probe.durationSeconds ?? fileDuration;
  const quote = durationForQuote ? quoteJob({ durationSeconds: durationForQuote, options, viaApi: false }) : null;
  const perItemQuote = (seconds: number) => quoteJob({ durationSeconds: seconds, options, viaApi: false });
  const selectedTotal = probe.items
    .filter((item) => selectedItems[item.url])
    .reduce((sum, item) => sum + (item.durationSeconds ? perItemQuote(item.durationSeconds).credits : 0), 0);
  const needed = probe.items.length > 0 ? selectedTotal : quote && !quote.free ? quote.credits : 0;
  const shortOfCredits = Boolean(onTopUp) && needed > credits;

  const started = (jobId: string) => {
    if (onStarted) onStarted(jobId);
    else window.location.assign(`/?job=${encodeURIComponent(jobId)}`);
  };

  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) {
      window.clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const pollJob = useCallback(
    (jobId: string, attempt = 0) => {
      stopPolling();
      pollTimer.current = window.setTimeout(
        async () => {
          try {
            const response = await fetch(`/api/v1/transcriptions/${jobId}`);
            if (response.ok) {
              const body = (await response.json()) as {
                transcription: {
                  status: string;
                  durationSeconds: number | null;
                  meta: {
                    items?: Array<{ url: string; title?: string; durationSeconds?: number }>;
                    hasCreatorCaptions?: boolean;
                  };
                  errorCode: string | null;
                };
              };
              const job = body.transcription;
              if (job.status === "preview_ready" || job.durationSeconds) {
                const items = job.meta.items ?? [];
                setProbe({
                  durationSeconds: job.durationSeconds,
                  items,
                  hasCreatorCaptions: Boolean(job.meta.hasCreatorCaptions),
                  failed: null,
                });
                setChecking(false);
                if (items.length > 0) {
                  setSelectedItems(Object.fromEntries(items.map((item) => [item.url, true])));
                }
                return;
              }
              if (job.status === "failed") {
                setProbe({
                  durationSeconds: null,
                  items: [],
                  hasCreatorCaptions: false,
                  failed: job.errorCode ?? "source_unavailable",
                });
                setChecking(false);
                return;
              }
            }
          } catch {
            /* keep polling until the attempt budget is spent */
          }
          if (attempt < 14) pollJob(jobId, attempt + 1);
          else setChecking(false);
        },
        attempt === 0 ? 700 : 1100,
      );
    },
    [stopPolling],
  );

  const checkLink = useCallback(
    async (value: string) => {
      const link = value.trim();
      if (!link) return;
      setError(null);
      setPreview(null);
      setProbe({ durationSeconds: null, items: [], hasCreatorCaptions: false, failed: null });
      setChecking(true);
      try {
        const response = await fetch("/api/v1/links/preview", {
          method: "POST",
          headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
          body: JSON.stringify({ url: link, turnstile_token: turnstileToken() }),
        });
        const body = (await response.json()) as { items?: PreviewItem[]; detail?: string };
        const item = body.items?.[0];
        if (!response.ok || !item) {
          setError(body.detail ?? (vi ? "Không xem trước được liên kết này." : "This link could not be previewed."));
          setChecking(false);
          return;
        }
        setPreview(item);
        if (item.job_id) pollJob(item.job_id);
        else setChecking(false);
      } catch {
        setError(vi ? "Không kết nối được máy chủ." : "Could not reach the server.");
        setChecking(false);
      }
    },
    [csrfToken, pollJob, vi],
  );

  const onFile = async (selected: File | null) => {
    setError(null);
    setFile(selected);
    setFileDuration(null);
    if (!selected) return;
    if (selected.size > maxUploadMb * 1024 * 1024) {
      setError(vi ? `Tệp phải nhỏ hơn ${maxUploadMb} MB.` : `Files must be smaller than ${maxUploadMb} MB.`);
      setFile(null);
      return;
    }
    const media = document.createElement(selected.type.startsWith("video") ? "video" : "audio");
    media.preload = "metadata";
    media.src = URL.createObjectURL(selected);
    media.onloadedmetadata = () => {
      if (Number.isFinite(media.duration)) setFileDuration(media.duration);
      URL.revokeObjectURL(media.src);
    };
    media.onerror = () => URL.revokeObjectURL(media.src);
  };

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      if (tab === "upload") {
        if (!file) throw new Error(vi ? "Chọn một tệp trước." : "Choose a file first.");
        setUploadProgress(vi ? "Đang tải tệp lên…" : "Uploading…");
        const create = await fetch("/api/v1/uploads", {
          method: "POST",
          headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
          body: JSON.stringify({ filename: file.name, content_type: file.type, size: file.size }),
        });
        const session = (await create.json()) as { upload_id?: string; url?: string; detail?: string };
        if (!create.ok || !session.url || !session.upload_id) {
          throw new Error(session.detail ?? (vi ? "Không tạo được phiên tải lên." : "Could not start the upload."));
        }
        const put = await fetch(session.url, { method: "PUT", body: file });
        if (!put.ok) throw new Error(vi ? "Tải tệp lên thất bại." : "The upload failed.");
        setUploadProgress(vi ? "Đang xếp hàng…" : "Queueing…");
        const created = await fetch("/api/v1/transcriptions", {
          method: "POST",
          headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
          body: JSON.stringify({ upload_id: session.upload_id, options, turnstile_token: turnstileToken() }),
        });
        const body = (await created.json()) as { transcription?: { id: string }; detail?: string };
        if (!created.ok || !body.transcription) throw new Error(body.detail ?? "Could not queue the file.");
        started(body.transcription.id);
        return;
      }

      const chosen = probe.items.filter((item) => selectedItems[item.url]);
      const payload = {
        ...(chosen.length > 1
          ? { items: chosen, options }
          : {
              ...(preview?.job_id ? { probe_id: preview.job_id } : { link: url.trim() }),
              options,
            }),
        turnstile_token: turnstileToken(),
      };
      const response = await fetch("/api/v1/transcriptions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as {
        transcription?: { id: string };
        transcriptions?: Array<{ id: string }>;
        detail?: string;
      };
      if (!response.ok) {
        throw new Error(body.detail ?? (vi ? "Không bắt đầu được." : "Could not start."));
      }
      const first = body.transcription?.id ?? body.transcriptions?.[0]?.id;
      if (first) started(first);
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : vi ? "Đã có lỗi." : "Something went wrong.");
    } finally {
      setBusy(false);
      setUploadProgress(null);
    }
  };

  return (
    <div className={`ta-new ta-new--${variant}`}>
      <div className="ta-new__tabs" role="tablist" aria-label={vi ? "Cách nhập" : "Input method"}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "link"}
          className={tab === "link" ? "is-active" : undefined}
          onClick={() => setTab("link")}
        >
          {vi ? "Dán liên kết" : "Paste a link"}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "upload"}
          className={tab === "upload" ? "is-active" : undefined}
          onClick={() => setTab("upload")}
        >
          {vi ? "Tải tệp lên" : "Upload a file"}
        </button>
      </div>

      {tab === "link" ? (
        <div className="ta-new__linkrow">
          <TextInput
            aria-label={vi ? "Liên kết media" : "Media link"}
            placeholder={
              vi
                ? "Dán liên kết YouTube, Drive, OneDrive, Dropbox hoặc MP3/MP4…"
                : "Paste a YouTube, Drive, OneDrive, Dropbox or MP3/MP4 link…"
            }
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onBlur={() => url && checkLink(url)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void checkLink(url);
              }
            }}
          />
          <Button variant="primary" size="lg" onClick={() => checkLink(url)} disabled={!url.trim() || checking}>
            {checking ? (vi ? "Đang kiểm tra…" : "Checking…") : vi ? "Xem trước" : "Preview"}
          </Button>
        </div>
      ) : (
        <div className="ta-new__upload">
          <label className="ta-new__drop">
            <input
              type="file"
              accept="audio/*,video/*"
              onChange={(event) => void onFile(event.target.files?.[0] ?? null)}
            />
            <span>
              {file
                ? file.name
                : vi
                  ? `Chọn hoặc kéo một tệp âm thanh/video (tối đa ${maxUploadMb} MB)`
                  : `Choose or drop an audio/video file (up to ${maxUploadMb} MB)`}
            </span>
          </label>
          <p className="ta-new__hint">
            {vi
              ? "Tệp đi thẳng vào lưu trữ; media bị xoá sau 24 giờ."
              : "The file goes straight to storage; media is deleted after 24 hours."}
          </p>
        </div>
      )}

      {error ? (
        <InlineNotice tone="danger" title={vi ? "Không bắt đầu được" : "Could not start"}>
          {error}
        </InlineNotice>
      ) : null}

      {preview?.error ? (
        <InlineNotice tone="warning" title={vi ? "Cần sửa liên kết" : "Fix this link"}>
          {linkErrorText(preview.error, preview.kind as never, locale)}
        </InlineNotice>
      ) : null}

      {preview && !preview.error ? (
        <div className="ta-new__preview">
          {preview.thumbnail ? (
            <img src={preview.thumbnail} alt="" width={160} height={90} loading="lazy" />
          ) : (
            <span className="ta-new__icon" aria-hidden="true">
              {preview.kind === "upload" ? "▲" : "▶"}
            </span>
          )}
          <div>
            <p className="ta-new__title">{preview.title ?? (vi ? "Đang lấy tiêu đề…" : "Fetching the title…")}</p>
            <p className="ta-new__meta">
              {checking && !probe.durationSeconds ? (vi ? "Đang đo độ dài…" : "Measuring duration…") : null}
              {probe.durationSeconds ? formatDuration(probe.durationSeconds) : null}
              {probe.failed ? linkErrorText(probe.failed, preview.kind as never, locale) : null}
            </p>
          </div>
        </div>
      ) : null}

      {probe.items.length > 0 ? (
        <fieldset className="ta-new__checklist">
          <legend>
            {vi
              ? `${probe.items.length} mục được tìm thấy — chọn để bóc băng`
              : `${probe.items.length} items found — choose what to transcribe`}
          </legend>
          {probe.items.map((item) => {
            const itemQuote = item.durationSeconds ? perItemQuote(item.durationSeconds) : null;
            return (
              <Checkbox
                key={item.url}
                label={`${item.title ?? item.url}${itemQuote ? ` · ${formatDuration(item.durationSeconds ?? 0)}` : ""}`}
                description={
                  itemQuote ? (itemQuote.free ? (vi ? "Miễn phí" : "Free") : `${itemQuote.credits} credits`) : undefined
                }
                checked={selectedItems[item.url] ?? true}
                onChange={(event) => setSelectedItems((current) => ({ ...current, [item.url]: event.target.checked }))}
              />
            );
          })}
          <p className="ta-new__total">
            {vi ? "Tổng" : "Total"}: {selectedTotal} credits
          </p>
        </fieldset>
      ) : null}

      <button
        type="button"
        className="ta-new__options-toggle"
        aria-expanded={optionsOpen}
        onClick={() => setOptionsOpen((value) => !value)}
      >
        {vi ? "Tuỳ chọn nâng cao" : "Advanced options"}
        <span aria-hidden="true">{optionsOpen ? "−" : "+"}</span>
      </button>

      {optionsOpen ? (
        <div className="ta-new__options">
          <Field label={vi ? "Ngôn ngữ" : "Language"}>
            {(props) => (
              <Select {...props} value={language} onChange={(event) => setLanguage(event.target.value)}>
                <option value="auto">{vi ? "Tự phát hiện" : "Detect automatically"}</option>
                <option value="en">English</option>
                <option value="vi">Tiếng Việt</option>
                <option value="es">Español</option>
                <option value="fr">Français</option>
                <option value="de">Deutsch</option>
                <option value="ja">日本語</option>
              </Select>
            )}
          </Field>
          <Checkbox
            label={
              vi
                ? `Mốc thời gian từng từ (+${PRICING.wordTimestampsCreditsPerMinute} credit/phút)`
                : `Word-level timestamps (+${PRICING.wordTimestampsCreditsPerMinute} credit/min)`
            }
            description={
              vi ? "Tải thêm SRT/VTT theo từng từ, đồng bộ kiểu karaoke." : "Adds karaoke-style word SRT/VTT downloads."
            }
            checked={wordTimestamps}
            disabled={captionOffer && useCaptions}
            onChange={(event) => setWordTimestamps(event.target.checked)}
          />
          {captionOffer ? (
            <Checkbox
              label={
                vi
                  ? "Dùng phụ đề có sẵn của người tạo (miễn phí mọi độ dài)"
                  : "Use the creator's captions (free at any length)"
              }
              description={
                vi
                  ? "Không bóc băng lại; chỉ lấy phụ đề đã có. Không có mốc thời gian từng từ."
                  : "No re-transcription; only the existing captions. Word timestamps are not available."
              }
              checked={useCaptions}
              onChange={(event) => setUseCaptions(event.target.checked)}
            />
          ) : null}
          <Field label={vi ? "Tóm tắt / lọc" : "Summary / filter"}>
            {(props) => (
              <Select
                {...props}
                value={summaryPreset}
                onChange={(event) => setSummaryPreset(event.target.value as SummaryPreset | "none")}
              >
                <option value="none">{vi ? "Không" : "None"}</option>
                <option value="short">{vi ? "Tóm tắt ngắn" : "Short summary"}</option>
                <option value="bullets">{vi ? "Các ý chính" : "Key points"}</option>
                <option value="chapters">{vi ? "Chương có mốc thời gian" : "Chapters with timestamps"}</option>
                <option value="qa">{vi ? "Hỏi & đáp" : "Q&A"}</option>
                <option value="filter">{vi ? "Chỉ giữ phần tôi cần" : "Only keep what I need"}</option>
              </Select>
            )}
          </Field>
          {summaryPreset === "filter" ? (
            <Field
              label={vi ? "Bạn muốn giữ phần nào?" : "What should we keep?"}
              hint={vi ? "Ví dụ: chỉ các phần nói về giá." : "For example: only the parts about pricing."}
            >
              {(props) => (
                <TextInput
                  {...props}
                  value={summaryInstruction}
                  onChange={(event) => setSummaryInstruction(event.target.value)}
                  maxLength={500}
                />
              )}
            </Field>
          ) : null}
          {summaryPreset !== "none" ? (
            <p className="ta-new__hint">
              {vi
                ? `Tóm tắt dùng model miễn phí của OpenRouter và có thể bị nhà cung cấp ghi log prompt. +${PRICING.summaryCredits} credit, chỉ tính khi thành công.`
                : `Summary uses OpenRouter free models and the provider may log prompts. +${PRICING.summaryCredits} credits, charged only on success.`}
            </p>
          ) : null}
        </div>
      ) : null}

      {needsHumanCheck ? (
        <div className="ta-new__turnstile">
          <div ref={turnstileBox} className="cf-turnstile" data-sitekey={turnstileSiteKey} data-theme="light" />
          <p className="ta-new__hint">
            {vi
              ? "Kiểm tra nhanh để chống lạm dụng lượt miễn phí. Không dùng cho quảng cáo."
              : "A quick bot check protects the free tier. It is not used for advertising."}
          </p>
        </div>
      ) : null}

      <div className="ta-new__actions">
        {shortOfCredits ? (
          <Button variant="primary" size="lg" onClick={() => onTopUp?.(tab === "link" ? url.trim() || null : null)}>
            {vi ? "Nạp credit và bóc băng" : "Top up and transcribe"}
          </Button>
        ) : (
          <Button variant="primary" size="lg" onClick={submit} disabled={busy || (tab === "link" && !url.trim())}>
            {busy ? (uploadProgress ?? (vi ? "Đang bắt đầu…" : "Starting…")) : vi ? "Bóc băng" : "Transcribe"}
          </Button>
        )}
        {quote ? (
          <Badge tone={quote.free ? "success" : credits >= quote.credits ? "neutral" : "warning"}>
            {quote.free
              ? vi
                ? "Miễn phí"
                : "Free"
              : `${quote.credits} credits${credits < quote.credits ? (vi ? " · thiếu credit" : " · not enough credits") : ""}`}
          </Badge>
        ) : null}
      </div>

      <p className="ta-new__free">
        {vi
          ? "Media tối đa 3 phút miễn phí. Người dùng đã đăng nhập: 25 lượt/ngày, khách: 5 lượt/ngày."
          : "Media up to 3 minutes is free. Signed-in: 25 a day, guests: 5 a day."}
      </p>
      {!signedIn ? (
        <p className="ta-new__hint">
          {vi ? "Cần bóc băng dài hơn? " : "Need longer media? "}
          <a
            href="/?signin=1"
            onClick={(event) => {
              if (!onSignIn) return;
              event.preventDefault();
              onSignIn();
            }}
          >
            {vi ? "Đăng nhập" : "Sign in"}
          </a>
          {vi ? " để mua credit." : " to buy credits."}
        </p>
      ) : null}
    </div>
  );
}
