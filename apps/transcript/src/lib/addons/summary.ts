import { releaseCredits, settleCredits } from "@templatedesign/platform/credits";
import type { Db } from "@templatedesign/platform/db";
import { getJob, type JobRow } from "../jobs";
import { chat, LlmUnavailableError } from "../llm/openrouter";
import type { SummaryOptions } from "../pricing";
import { PRICING as _PRICING } from "../pricing";
import { getJson, putJson, resultKey } from "../r2-presign";
import type { AddonState, NormalizedTranscript, TranscriptSegment } from "../transcripts";
import type { Env } from "../types";

/**
 * Summary / filter add-on. Runs in the Worker after the transcript is delivered, so a
 * failure never costs the user the transcript: the add-on credits are released and the
 * transcript API keeps returning the transcript plus `addons.status = "failed"`.
 */

export type { AddonState } from "../transcripts";

const PRESET_PROMPTS: Record<Exclude<SummaryOptions["preset"], "filter">, string> = {
  short: "Write a concise summary of the transcript in 3–5 sentences.",
  bullets: "List the 5–9 key points as short bullet lines.",
  chapters: "Produce chapter headings with their start timestamps in mm:ss. One line per chapter: `mm:ss — heading`.",
  qa: "Write 4–6 question and answer pairs a reader would ask about this transcript.",
};

const MAX_CHARS_PER_CHUNK = 6000;

export function chunkSegments(segments: TranscriptSegment[], maxChars = MAX_CHARS_PER_CHUNK): TranscriptSegment[][] {
  const chunks: TranscriptSegment[][] = [];
  let current: TranscriptSegment[] = [];
  let size = 0;
  for (const segment of segments) {
    const length = segment.text.length + 1;
    if (size + length > maxChars && current.length > 0) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(segment);
    size += length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function withTimestamps(segments: TranscriptSegment[]): string {
  return segments
    .map((segment) => {
      const minutes = Math.floor(segment.start / 60);
      const seconds = Math.floor(segment.start % 60);
      return `[${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}] ${segment.text.trim()}`;
    })
    .join("\n");
}

function instructionFor(options: SummaryOptions): string {
  if (options.preset === "filter") {
    return `Keep only the passages that match this request: "${options.instruction ?? ""}". Reply with the matching lines only, each line starting with its [mm:ss] timestamp. If nothing matches, reply exactly NONE.`;
  }
  return PRESET_PROMPTS[options.preset];
}

/**
 * Summarises a long transcript in chunks and merges the parts. The first call also decides
 * the language so a Vietnamese transcript stays Vietnamese.
 */
export async function summarise(
  env: Env,
  db: Db,
  transcript: NormalizedTranscript,
  options: SummaryOptions,
  fetcher?: typeof fetch,
): Promise<{ text: string; model: string }> {
  const language = options.language ?? transcript.language ?? "en";
  const system = `You work on transcripts. Answer in ${language}. Do not invent facts that are not in the transcript.`;
  const chunks = chunkSegments(transcript.segments);
  if (chunks.length === 1) {
    const result = await chat(
      env,
      db,
      [
        { role: "system", content: system },
        { role: "user", content: `${instructionFor(options)}\n\nTranscript:\n${withTimestamps(chunks[0])}` },
      ],
      { fetcher, maxTokens: options.preset === "filter" ? 1200 : 800 },
    );
    return { text: result.content, model: result.model };
  }

  const partials: string[] = [];
  for (const chunk of chunks) {
    const result = await chat(
      env,
      db,
      [
        { role: "system", content: system },
        {
          role: "user",
          content: `Summarise this part of a longer transcript in 3 bullet lines, keeping timestamps.\n\n${withTimestamps(chunk)}`,
        },
      ],
      { fetcher, maxTokens: 400 },
    );
    partials.push(result.content);
  }
  const merged = await chat(
    env,
    db,
    [
      { role: "system", content: system },
      {
        role: "user",
        content: `${instructionFor(options)}\n\nPart summaries:\n${partials.join("\n\n")}`,
      },
    ],
    { fetcher, maxTokens: 900 },
  );
  return { text: merged.content, model: merged.model };
}

const TIMESTAMP_LINE = /^\[?(\d{1,2}):(\d{2})\]?\s*[-—:]?\s*(.+)$/;

/** Filter results come back as timestamped lines; only lines that match a known segment are kept. */
export function parseFiltered(
  text: string,
  segments: TranscriptSegment[],
): Array<{ start: number; end: number; text: string }> {
  if (/^\s*NONE\s*$/i.test(text)) return [];
  const byTime = new Map<number, TranscriptSegment>();
  for (const segment of segments) byTime.set(Math.floor(segment.start), segment);
  const picked: Array<{ start: number; end: number; text: string }> = [];
  for (const raw of text.split("\n")) {
    const match = TIMESTAMP_LINE.exec(raw.trim());
    if (!match) continue;
    const start = Number(match[1]) * 60 + Number(match[2]);
    const segment = byTime.get(start);
    if (!segment) continue;
    if (picked.some((entry) => entry.start === segment.start)) continue;
    picked.push({ start: segment.start, end: segment.end, text: (match[3] ?? segment.text).trim() });
  }
  return picked.sort((a, b) => a.start - b.start);
}

async function setAddonState(db: Db, jobId: string, state: AddonState): Promise<void> {
  await db.run("UPDATE transcription_jobs SET addons_json = ?, updated_at = ? WHERE id = ?", [
    JSON.stringify({ ...state, updatedAt: new Date().toISOString() }),
    new Date().toISOString(),
    jobId,
  ]);
}

/**
 * Entry point for the `addons` stage. Credits for the summary are still reserved on the job;
 * they settle here on success and are released on any failure.
 */
export async function runAddons(env: Env, db: Db, jobId: string, fetcher?: typeof fetch): Promise<AddonState> {
  const job = await getJob(db, jobId);
  if (!job) return { status: "failed", error: "not_found" };
  const options = parseOptions(job);
  if (!options.summary) return { status: "done" };
  const transcript = await getJson<NormalizedTranscript>(env, resultKey(jobId, "transcript.json"));
  if (!transcript) {
    await setAddonState(db, jobId, { status: "failed", error: "transcript_missing" });
    return { status: "failed", error: "transcript_missing" };
  }

  try {
    const result = await summarise(env, db, transcript, options.summary, fetcher);
    const state: AddonState =
      options.summary.preset === "filter"
        ? {
            status: "done",
            preset: "filter",
            model: result.model,
            filtered: parseFiltered(result.text, transcript.segments),
          }
        : { status: "done", preset: options.summary.preset, model: result.model, summary: result.text };
    await setAddonState(db, jobId, state);
    await putJson(env, resultKey(jobId, "addons.json"), state);
    await settleAddonCredits(db, job, true);
    return state;
  } catch (error) {
    const reason = error instanceof LlmUnavailableError ? error.reason : "failed";
    const state: AddonState = { status: "failed", preset: options.summary.preset, error: reason };
    await setAddonState(db, jobId, state);
    await settleAddonCredits(db, job, false);
    return state;
  }
}

/** Settles or releases only the add-on part of the reservation, exactly once. */
async function settleAddonCredits(db: Db, job: JobRow, success: boolean): Promise<void> {
  if (!job.tenant_id) return;
  const held = job.reserved_credits;
  if (held <= 0) return;
  const claimed = await db.run(
    "UPDATE transcription_jobs SET reserved_credits = 0, pricing_state = 'settled' WHERE id = ? AND pricing_state = 'addon_pending'",
    [job.id],
  );
  if (claimed.changes !== 1) return;
  if (success) {
    await settleCredits(db, job.tenant_id, job.id, held, held);
    await db.run("UPDATE transcription_jobs SET charged_credits = charged_credits + ? WHERE id = ?", [held, job.id]);
  } else {
    await releaseCredits(db, job.tenant_id, job.id, held);
  }
}

function parseOptions(job: JobRow): { summary?: SummaryOptions | null } {
  try {
    return JSON.parse(job.options_json) as { summary?: SummaryOptions | null };
  } catch {
    return {};
  }
}

/** Wording for the UI when the add-on could not run. */
export function addonErrorText(reason: string | undefined, locale: "en" | "vi"): string {
  const en: Record<string, string> = {
    disabled: "The summary add-on is turned off right now. Its credits were released.",
    budget: "The summary add-on hit its daily free limit. Its credits were released.",
    all_failed: "The summary service is unavailable. Your transcript is ready and the add-on credits were released.",
    no_key: "The summary add-on is not configured. Its credits were released.",
    transcript_missing: "The transcript could not be read for summarising.",
  };
  const vi: Record<string, string> = {
    disabled: "Tính năng tóm tắt đang tắt. Credit đã được hoàn lại.",
    budget: "Tính năng tóm tắt đã hết lượt miễn phí hôm nay. Credit đã được hoàn lại.",
    all_failed: "Dịch vụ tóm tắt không khả dụng. Bản ghi vẫn sẵn sàng và credit đã được hoàn lại.",
    no_key: "Tính năng tóm tắt chưa được cấu hình. Credit đã được hoàn lại.",
    transcript_missing: "Không đọc được bản ghi để tóm tắt.",
  };
  const table = locale === "vi" ? vi : en;
  return table[reason ?? ""] ?? (locale === "vi" ? "Không tạo được tóm tắt." : "The summary could not be created.");
}

export const ADDON_CREDITS = _PRICING.summaryCredits;
