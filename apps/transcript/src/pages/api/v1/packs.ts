import { handleApi, json } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { CREDIT_PACKS, perMinuteCents } from "../../../lib/packs";
import { PRICING } from "../../../lib/pricing";

export const GET: APIRoute = async ({ request }) =>
  handleApi(request, async () =>
    json({
      currency: "USD",
      credit_unit: "minute",
      expiry_months: 24,
      credits_per_minute: PRICING.creditsPerMinute,
      free_max_seconds: PRICING.freeMaxSeconds,
      packs: CREDIT_PACKS.map((pack) => ({
        id: pack.id,
        name: pack.name,
        price_cents: pack.priceCents,
        credits: pack.credits,
        minutes: Math.floor(pack.credits / PRICING.creditsPerMinute),
        per_minute_cents: Math.round(perMinuteCents(pack, PRICING.creditsPerMinute) * 100) / 100,
      })),
      addons: {
        word_timestamps_credits_per_minute: PRICING.wordTimestampsCreditsPerMinute,
        summary_credits: PRICING.summaryCredits,
        api_credits_per_job: PRICING.apiSurchargeCredits,
      },
    }),
  );
