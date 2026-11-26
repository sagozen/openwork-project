import assert from "node:assert/strict";
import { test } from "node:test";
import { billableMinutes, PRICING, quoteJob } from "../src/lib/pricing-core";

test("free boundary is inclusive at 180 s and paid at 181 s", () => {
  const short = quoteJob({ durationSeconds: 180, options: {}, viaApi: false });
  assert.equal(short.free, true);
  assert.equal(short.credits, 0);
  assert.equal(short.billableMinutes, 3);

  const long = quoteJob({ durationSeconds: 181, options: {}, viaApi: false });
  assert.equal(long.free, false);
  assert.equal(long.billableMinutes, 4);
  assert.equal(long.credits, 12);
});

test("started minutes round up at 59/60/61 seconds", () => {
  assert.equal(billableMinutes(59), 1);
  assert.equal(billableMinutes(60), 1);
  assert.equal(billableMinutes(61), 2);
  const at59 = quoteJob({ durationSeconds: 59, options: {}, viaApi: false });
  const at60 = quoteJob({ durationSeconds: 60, options: {}, viaApi: false });
  const at61 = quoteJob({ durationSeconds: 61, options: {}, viaApi: false });
  assert.equal(at59.free, true);
  assert.equal(at60.free, true);
  // Still inside the ≤180 s free tier, but it would be two billable minutes once paid.
  assert.equal(at61.free, true);
  assert.equal(at61.credits, 0);
  assert.equal(at61.billableMinutes, 2);
});

test("add-ons are priced only when requested and stack correctly", () => {
  const freeWithSummary = quoteJob({ durationSeconds: 120, options: { summary: { preset: "short" } }, viaApi: false });
  assert.equal(freeWithSummary.free, false);
  assert.equal(freeWithSummary.credits, 2 * PRICING.creditsPerMinute + PRICING.summaryCredits);

  const words = quoteJob({ durationSeconds: 300, options: { word_timestamps: true }, viaApi: false });
  assert.equal(words.breakdown.wordTimestamps, 5);

  const api = quoteJob({ durationSeconds: 300, options: {}, viaApi: true });
  assert.equal(api.breakdown.api, PRICING.apiSurchargeCredits);
  assert.equal(api.credits, 15 + PRICING.apiSurchargeCredits);
});

test("creator captions are free at any length and never add word timestamps", () => {
  const captions = quoteJob({
    durationSeconds: 3600,
    options: { use_creator_captions: true, word_timestamps: true },
    viaApi: false,
  });
  assert.equal(captions.free, true);
  assert.equal(captions.breakdown.transcription, 0);
  assert.equal(captions.breakdown.wordTimestamps, 0);
  assert.equal(captions.credits, 0);

  const captionsWithSummary = quoteJob({
    durationSeconds: 3600,
    options: { use_creator_captions: true, summary: { preset: "bullets" } },
    viaApi: false,
  });
  assert.equal(captionsWithSummary.credits, PRICING.summaryCredits);
});

test("a zero or unknown duration still bills one started minute", () => {
  assert.equal(billableMinutes(0), 1);
  assert.equal(billableMinutes(Number.NaN), 1);
});
