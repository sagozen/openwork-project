/**
 * Every tunable lives here or in `admin_settings` (phase 6: "never inline"). The defaults
 * match the owner-approved price table in the plan.
 */
export const PRICING = {
  /** Media at or below this length is free when no add-on is requested. */
  freeMaxSeconds: 180,
  creditsPerMinute: 3,
  wordTimestampsCreditsPerMinute: 1,
  summaryCredits: 5,
  apiSurchargeCredits: 2,
  monthlyCapMinutes: 600,
  freeJobsPerDay: { guest: 5, user: 25 },
  captionFreePerDay: { guest: 20, user: 100 },
  freeQueueMaxWaitSeconds: 600,
  freeQueueMinutesPerDay: 300,
  /** A free job that has waited this long outranks any fresh paid job (anti-starvation). */
  freeStarvationSeconds: 900,
  fallbackAfterSeconds: 90,
  primaryFreshSeconds: 60,
  /**
   * Lease TTL. The worker extends every 60 s, so 180 s survives two lost extensions; a crashed
   * worker costs at most TTL + one cron tick (≈4 min) before the job is requeued.
   */
  leaseSeconds: 180,
  leaseExtendSeconds: 180,
  maxAttempts: 3,
  /** Batch and playlist caps. */
  maxLinksPerBatch: 50,
  maxUploadMbFree: 200,
  maxUploadMbPaid: 2048,
  mediaRetentionHours: 24,
  resultRetentionDays: 30,
} as const;

export interface SummaryOptions {
  /** One of the presets, or a free-form filter instruction. */
  preset: "short" | "bullets" | "chapters" | "qa" | "filter";
  instruction?: string;
  language?: string;
}

export interface JobOptions {
  language?: string;
  word_timestamps?: boolean;
  summary?: SummaryOptions | null;
  /** Use the creator's existing YouTube captions instead of transcribing. */
  use_creator_captions?: boolean;
}

export interface QuoteInput {
  durationSeconds: number;
  options: JobOptions;
  /** True when the job was created with an API key (phase 6: +2 credits). */
  viaApi: boolean;
}

export interface Quote {
  durationSeconds: number;
  billableMinutes: number;
  free: boolean;
  credits: number;
  breakdown: { transcription: number; wordTimestamps: number; summary: number; api: number };
}

export function billableMinutes(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 1;
  return Math.max(1, Math.ceil(durationSeconds / 60));
}

/** Word timestamps are not offered for creator captions, so the flag is ignored there. */
export function quoteJob(input: QuoteInput): Quote {
  const minutes = billableMinutes(input.durationSeconds);
  const captions = input.options.use_creator_captions === true;
  const wantsWords = input.options.word_timestamps === true && !captions;
  const wantsSummary = Boolean(input.options.summary);
  // Captions cost nothing to fetch, so they are free at any length (own daily quota).
  const free =
    (captions || input.durationSeconds <= PRICING.freeMaxSeconds) && !wantsWords && !wantsSummary && !input.viaApi;
  if (free) {
    return {
      durationSeconds: input.durationSeconds,
      billableMinutes: minutes,
      free: true,
      credits: 0,
      breakdown: { transcription: 0, wordTimestamps: 0, summary: 0, api: 0 },
    };
  }
  const transcription = captions ? 0 : minutes * PRICING.creditsPerMinute;
  const wordTimestamps = wantsWords ? minutes * PRICING.wordTimestampsCreditsPerMinute : 0;
  const summary = wantsSummary ? PRICING.summaryCredits : 0;
  const api = input.viaApi ? PRICING.apiSurchargeCredits : 0;
  return {
    durationSeconds: input.durationSeconds,
    billableMinutes: minutes,
    free: false,
    credits: transcription + wordTimestamps + summary + api,
    breakdown: { transcription, wordTimestamps, summary, api },
  };
}

/** Human wording used by the link preview and the transcript table. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
