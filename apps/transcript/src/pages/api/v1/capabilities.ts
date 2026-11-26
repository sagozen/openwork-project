import { handleApi, json } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { CREDIT_PACKS } from "../../../lib/packs";
import { PRICING } from "../../../lib/pricing";

/** Machine-readable feature list, used by the docs and by clients that pick a format. */
export const GET: APIRoute = async ({ request }) =>
  handleApi(request, async () =>
    json({
      api_version: "v1",
      sources: [
        "upload",
        "gdrive",
        "onedrive",
        "dropbox",
        "direct",
        "youtube",
        "tiktok",
        "facebook",
        "instagram",
        "x",
        "vimeo",
        "loom",
        "soundcloud",
        "rss",
      ],
      formats: ["json", "txt", "srt", "vtt"],
      addons: ["word_timestamps", "summary", "filter"],
      limits: {
        free_max_seconds: PRICING.freeMaxSeconds,
        free_jobs_per_day: PRICING.freeJobsPerDay,
        monthly_cap_minutes: PRICING.monthlyCapMinutes,
        max_links_per_batch: PRICING.maxLinksPerBatch,
        max_upload_mb_free: PRICING.maxUploadMbFree,
        max_upload_mb_paid: PRICING.maxUploadMbPaid,
        media_retention_hours: PRICING.mediaRetentionHours,
        result_retention_days: PRICING.resultRetentionDays,
      },
      webhook_events: ["transcription.completed", "transcription.failed"],
      packs: CREDIT_PACKS.map((pack) => ({ id: pack.id, credits: pack.credits, price_cents: pack.priceCents })),
      features: { webhooks: true, api_keys: true, summary: true, word_timestamps: true, checkout: false },
    }),
  );
