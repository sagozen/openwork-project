import type { APIRoute } from "astro";
import { formatUsd, packSummary } from "../lib/packs";
import { PRICING } from "../lib/pricing-core";

/** Machine-readable index for agents and answer engines (llmstxt.org layout). */
export const GET: APIRoute = async () => {
  const [starter] = packSummary("en", PRICING.creditsPerMinute);
  const freeMinutes = PRICING.freeMaxSeconds / 60;
  const body = `# TranscriptAnything

> Paste a Drive, OneDrive, Dropbox, YouTube, TikTok or direct MP3/MP4 link (or upload a file) and get a transcript with timestamps. Media up to ${freeMinutes} minutes is free; longer media costs ${PRICING.creditsPerMinute} credits per started minute. Public API and webhooks.

## Docs
- [Documentation](https://transcriptanything.zhst.app/docs): quickstart, API, webhooks, limits, errors, n8n, sources and add-ons on one page.
- [Full docs as Markdown](https://transcriptanything.zhst.app/llms-full.txt): the same page as one text file.
- [API reference](https://transcriptanything.zhst.app/docs#endpoints): Bearer API keys, \`POST /api/v1/transcriptions\`, \`GET …/{id}\`, \`GET …/{id}/result?format=json|txt|srt|vtt\`, \`POST /api/v1/links/preview\`, \`POST /api/v1/uploads\`.
- [Webhooks](https://transcriptanything.zhst.app/docs#webhooks): \`transcription.completed\`, \`transcription.failed\`, HMAC-SHA256 over \`timestamp.body\`, five retries.
- [OpenAPI](https://transcriptanything.zhst.app/openapi.yaml)
- [Capabilities](https://transcriptanything.zhst.app/api/v1/capabilities)
- [Packs](https://transcriptanything.zhst.app/api/v1/packs)

## Product
- [Home](https://transcriptanything.zhst.app/): link-first transcription, 20+ sources, TXT/SRT/VTT/JSON.
- [Pricing](https://transcriptanything.zhst.app/docs#limits): ${formatUsd(starter.priceCents)} = ${starter.credits.toLocaleString("en-US")} credits ≈ ${starter.minutes} minutes; summary +${PRICING.summaryCredits} credits; word timestamps +${PRICING.wordTimestampsCreditsPerMinute} credit/min; API +${PRICING.apiSurchargeCredits} credits per job.
- [Terms](https://transcriptanything.zhst.app/legal#terms): you must own or be licensed to use the media; DRM is not supported.
- [Privacy](https://transcriptanything.zhst.app/legal#privacy): media ${PRICING.mediaRetentionHours} h, transcripts ${PRICING.resultRetentionDays} days, OpenRouter free models may log prompts.
`;
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
};
