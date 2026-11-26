import { fillPlaceholders } from "@templatedesign/platform/docs-markdown";
import { packSummary } from "./packs";
import { PRICING } from "./pricing-core";

/**
 * Values for the `{{name}}` placeholders in `src/content/docs.md`. Every number comes from
 * `PRICING` or the pack list, so the docs cannot drift from billing.
 */
export function docsValues(): Record<string, string | number> {
  const packTable = [
    "| Pack | Price | Credits | About | Per minute |",
    "|---|---|---|---|---|",
    ...packSummary("en", PRICING.creditsPerMinute).map(
      (pack) =>
        `| ${pack.name} | ${pack.price} | ${pack.credits.toLocaleString("en-US")} | ${pack.minutes.toLocaleString("en-US")} min | ${pack.perMinute} |`,
    ),
  ].join("\n");
  return {
    freeMinutes: PRICING.freeMaxSeconds / 60,
    creditsPerMinute: PRICING.creditsPerMinute,
    wordTimestampsCreditsPerMinute: PRICING.wordTimestampsCreditsPerMinute,
    summaryCredits: PRICING.summaryCredits,
    apiSurchargeCredits: PRICING.apiSurchargeCredits,
    monthlyCapMinutes: PRICING.monthlyCapMinutes.toLocaleString("en-US"),
    guestFreeJobs: PRICING.freeJobsPerDay.guest,
    userFreeJobs: PRICING.freeJobsPerDay.user,
    guestFreeCaptions: PRICING.captionFreePerDay.guest,
    userFreeCaptions: PRICING.captionFreePerDay.user,
    maxLinksPerBatch: PRICING.maxLinksPerBatch,
    maxUploadMbFree: PRICING.maxUploadMbFree,
    maxUploadGbPaid: PRICING.maxUploadMbPaid / 1024,
    mediaRetentionHours: PRICING.mediaRetentionHours,
    resultRetentionDays: PRICING.resultRetentionDays,
    packTable,
  };
}

/** The docs Markdown with every placeholder filled. */
export function docsSource(raw: string): string {
  return fillPlaceholders(raw, docsValues());
}
