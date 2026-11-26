export interface TranscriptWord {
  start: number;
  end: number;
  word: string;
  /** Probability, 0–1, when the engine reports one. */
  p?: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words?: TranscriptWord[];
}

export interface NormalizedTranscript {
  segments: TranscriptSegment[];
  language?: string;
  model?: string;
  /** Present when the worker produced word-level timing. */
  word_timestamps?: boolean;
}

export interface StoredTranscript extends NormalizedTranscript {
  formats?: string[];
}

/** Summary/filter add-on state, stored on the job and in `results/<id>/addons.json`. */
export interface AddonState {
  status: "pending" | "done" | "failed";
  preset?: string;
  model?: string;
  summary?: string;
  filtered?: Array<{ start: number; end: number; text: string }>;
  error?: string;
  updatedAt?: string;
}

function pad(value: number, size = 2): string {
  return String(Math.floor(value)).padStart(size, "0");
}

/** SRT wants `HH:MM:SS,mmm`. */
export function srtTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = Math.floor(clamped % 60);
  const millis = Math.round((clamped - Math.floor(clamped)) * 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(millis, 3)}`;
}

/** WebVTT wants `HH:MM:SS.mmm`. */
export function vttTime(seconds: number): string {
  return srtTime(seconds).replace(",", ".");
}

export function buildSrt(segments: TranscriptSegment[], words?: TranscriptWord[]): string {
  if (words && words.length > 0) return buildWordSrt(words);
  const blocks = segments.map((segment, index) => {
    const end = segment.end > segment.start ? segment.end : segment.start + 0.001;
    return `${index + 1}\n${srtTime(segment.start)} --> ${srtTime(end)}\n${segment.text.trim()}\n`;
  });
  return `${blocks.join("\n")}\n`;
}

export function buildVtt(segments: TranscriptSegment[], words?: TranscriptWord[]): string {
  const cues =
    words && words.length > 0
      ? words.map((word, index) => `${index + 1}\n${vttTime(word.start)} --> ${vttTime(word.end)}\n${word.word}\n`)
      : segments.map(
          (segment, index) =>
            `${index + 1}\n${vttTime(segment.start)} --> ${vttTime(segment.end > segment.start ? segment.end : segment.start + 0.001)}\n${segment.text.trim()}\n`,
        );
  return `WEBVTT\n\n${cues.join("\n")}\n`;
}

/** Word-level SRT, one cue per word — the karaoke download offered with the add-on. */
export function buildWordSrt(words: TranscriptWord[]): string {
  return `${words
    .map((word, index) => {
      const end = word.end > word.start ? word.end : word.start + 0.08;
      return `${index + 1}\n${srtTime(word.start)} --> ${srtTime(end)}\n${word.word}\n`;
    })
    .join("\n")}\n`;
}

export function flattenWords(transcript: NormalizedTranscript): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  for (const segment of transcript.segments) {
    if (!segment.words?.length) continue;
    words.push(...segment.words);
  }
  return words;
}

export function transcriptText(transcript: NormalizedTranscript): string {
  return transcript.segments
    .map((segment) => segment.text.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Validate and repair a worker result before it is stored. Rejects anything that would
 * produce an unusable transcript (no segments, non-numeric timings) so the job fails on the
 * worker instead of delivering a broken file.
 */
export function normalizeTranscript(input: unknown): NormalizedTranscript {
  if (!input || typeof input !== "object") throw new Error("transcript must be an object");
  const candidate = input as { segments?: unknown; language?: unknown; model?: unknown; word_timestamps?: unknown };
  if (!Array.isArray(candidate.segments)) throw new Error("transcript.segments must be an array");
  const segments: TranscriptSegment[] = [];
  for (const raw of candidate.segments) {
    if (!raw || typeof raw !== "object") continue;
    const segment = raw as { start?: unknown; end?: unknown; text?: unknown; words?: unknown };
    const start = Number(segment.start);
    const end = Number(segment.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const text = typeof segment.text === "string" ? segment.text.trim() : "";
    if (!text && !Array.isArray(segment.words)) continue;
    const words = Array.isArray(segment.words)
      ? (segment.words as TranscriptWord[]).filter(
          (word) => Number.isFinite(Number(word?.start)) && Number.isFinite(Number(word?.end)),
        )
      : undefined;
    segments.push({ start: Math.max(0, start), end: Math.max(start, end), text, ...(words ? { words } : {}) });
  }
  if (segments.length === 0) throw new Error("transcript has no usable segments");
  segments.sort((a, b) => a.start - b.start);
  return {
    segments,
    language: typeof candidate.language === "string" ? candidate.language : undefined,
    model: typeof candidate.model === "string" ? candidate.model : undefined,
    word_timestamps: candidate.word_timestamps === true || segments.some((segment) => segment.words?.length),
  };
}

export function transcriptStats(transcript: NormalizedTranscript) {
  const words = transcript.segments.reduce(
    (total, segment) => total + segment.text.trim().split(/\s+/).filter(Boolean).length,
    0,
  );
  const last = transcript.segments[transcript.segments.length - 1];
  return {
    segments: transcript.segments.length,
    words,
    durationSeconds: last ? Math.ceil(last.end) : 0,
    language: transcript.language ?? null,
    model: transcript.model ?? null,
    hasWordTimestamps: Boolean(transcript.word_timestamps),
  };
}

/** `[00:12] text` lines, used by the summary/filter panel and DOCX export. */
export function timestampedLines(transcript: NormalizedTranscript): Array<{ time: string; text: string }> {
  return transcript.segments.map((segment) => {
    const minutes = Math.floor(segment.start / 60);
    const seconds = Math.floor(segment.start % 60);
    return { time: `${pad(minutes)}:${pad(seconds)}`, text: segment.text.trim() };
  });
}
