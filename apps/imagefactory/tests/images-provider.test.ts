import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { ImageError } from "../src/lib/images/errors";
import { createFalProvider } from "../src/lib/images/fal";
import { MODELS } from "../src/lib/images/models";
import { assertSize, billedMegapixels, creditsFor } from "../src/lib/images/pricing";
import {
  extensionFor,
  IMAGE_ID_PATTERN,
  newImageId,
  signedReferenceUrl,
  sniffImageMime,
  verifyReferenceSignature,
} from "../src/lib/images/storage";
import { JWKS_URL, resetJwksCache, verifyFalWebhook } from "../src/lib/images/webhook-verify";

test("megapixels are billed per started megapixel", () => {
  assert.equal(billedMegapixels(816, 1224), 1);
  assert.equal(billedMegapixels(1024, 1024), 2);
  assert.equal(billedMegapixels(1024, 1536), 2);
  assert.equal(billedMegapixels(1152, 1728), 2);
  assert.equal(billedMegapixels(1344, 768), 2);
  assert.equal(creditsFor(MODELS["qwen-image"], 816, 1224, 3), 12);
  assert.equal(creditsFor(MODELS["qwen-edit"], 1152, 1728, 1), 12);
  assert.equal(creditsFor(MODELS["qwen-image"], 816, 1224, 1, { creditsPerMp: { "qwen-image": 10 } }), 10);
});

test("sizes and counts outside the model limits are refused", () => {
  const model = MODELS["qwen-image"];
  assert.throws(() => assertSize(model, 100, 100, 1), ImageError);
  assert.throws(() => assertSize(model, 4096, 4096, 1), ImageError);
  assert.throws(() => assertSize(model, 1024, 1024, 5), ImageError);
  assert.throws(() => assertSize(model, 1024.5, 1024, 1), ImageError);
  assert.doesNotThrow(() => assertSize(model, 1024, 1024, 4));
});

test("image ids are 26 lowercase base32 characters and do not repeat", () => {
  const ids = new Set(Array.from({ length: 200 }, () => newImageId()));
  assert.equal(ids.size, 200);
  for (const value of ids) assert.match(value, IMAGE_ID_PATTERN);
});

test("uploads are recognised by their bytes, not by what they claim to be", () => {
  assert.equal(sniffImageMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), "image/png");
  assert.equal(sniffImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  const webp = new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ");
  assert.equal(sniffImageMime(webp), "image/webp");
  assert.equal(sniffImageMime(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
  assert.equal(extensionFor("image/jpeg"), "jpg");
});

test("a signed reference link verifies, expires and cannot be moved to another asset", async () => {
  const now = Date.parse("2026-11-06T00:00:00Z");
  const url = new URL(await signedReferenceUrl("https://host.test", "secret", "bas_1", now, 600));
  const exp = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");
  assert.equal(await verifyReferenceSignature("secret", "bas_1", exp, sig, now + 1000), true);
  assert.equal(await verifyReferenceSignature("secret", "bas_2", exp, sig, now + 1000), false);
  assert.equal(await verifyReferenceSignature("other", "bas_1", exp, sig, now + 1000), false);
  assert.equal(await verifyReferenceSignature("secret", "bas_1", exp, sig, now + 601_000), false);
  assert.equal(await verifyReferenceSignature("secret", "bas_1", null, sig, now), false);
});

function recorder(responses: Array<Response | (() => Response)>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return typeof next === "function" ? next() : next;
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("submit posts the prompt to the model endpoint with the key, the webhook and no stored history", async () => {
  const { calls, fetcher } = recorder([
    jsonResponse({
      request_id: "r1",
      status_url: "https://q/s",
      response_url: "https://q/r",
      cancel_url: "https://q/c",
    }),
  ]);
  const provider = createFalProvider({ key: "k123", fetch: fetcher });
  const job = await provider.submit({
    model: MODELS["qwen-edit"],
    prompt: "Using image 1 as the style reference, a pin",
    negativePrompt: "blurry",
    width: 816,
    height: 1224,
    numImages: 2,
    seed: 5,
    imageUrls: ["https://h/i/a.png"],
    outputFormat: "png",
    webhookUrl: "https://h/api/v1/fal-webhook",
  });
  assert.equal(job.providerJobId, "r1");
  assert.equal(job.statusUrl, "https://q/s");
  const [{ url, init }] = calls;
  assert.equal(
    url,
    "https://queue.fal.run/fal-ai/qwen-image-edit-2511?fal_webhook=https%3A%2F%2Fh%2Fapi%2Fv1%2Ffal-webhook",
  );
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Key k123");
  assert.equal(headers["x-fal-store-io"], "0");
  const body = JSON.parse(String(init.body));
  assert.deepEqual(body.image_size, { width: 816, height: 1224 });
  assert.deepEqual(body.image_urls, ["https://h/i/a.png"]);
  assert.equal(body.seed, 5);
  assert.equal(body.num_images, 2);
  assert.equal(body.negative_prompt, "blurry");
  assert.equal(body.enable_safety_checker, true);
});

test("status maps the queue states and result flags blocked images", async () => {
  const { fetcher } = recorder([
    jsonResponse({ status: "IN_QUEUE", queue_position: 4 }),
    jsonResponse({ status: "IN_PROGRESS" }),
    jsonResponse({ status: "COMPLETED" }),
    jsonResponse({
      images: [
        { url: "https://f/a.png", width: 816, height: 1224, content_type: "image/png" },
        { url: "https://f/b.png", width: 816, height: 1224, content_type: "image/png" },
      ],
      seed: 77,
      has_nsfw_concepts: [false, true],
    }),
  ]);
  const provider = createFalProvider({ key: "k", fetch: fetcher });
  assert.deepEqual(await provider.status({ statusUrl: "u" }), { state: "queued", queuePosition: 4 });
  assert.deepEqual(await provider.status({ statusUrl: "u" }), { state: "running" });
  assert.deepEqual(await provider.status({ statusUrl: "u" }), { state: "done" });
  const result = await provider.result({ responseUrl: "u" });
  assert.equal(result.seed, 77);
  assert.deepEqual(
    result.images.map((image) => image.blocked),
    [false, true],
  );
});

test("rate limits and server errors are retryable; validation errors are not", async () => {
  const { fetcher } = recorder([
    new Response("slow down", { status: 429 }),
    new Response("oops", { status: 503 }),
    new Response('{"detail":"prompt too long"}', { status: 422 }),
    new Response("no", { status: 401 }),
  ]);
  const provider = createFalProvider({ key: "k", fetch: fetcher });
  const submit = () =>
    provider.submit({
      model: MODELS["qwen-image"],
      prompt: "p",
      width: 512,
      height: 512,
      numImages: 1,
      outputFormat: "png",
    });
  await assert.rejects(
    submit,
    (error: unknown) => error instanceof ImageError && error.code === "PROVIDER_ERROR" && error.retryable,
  );
  await assert.rejects(
    submit,
    (error: unknown) => error instanceof ImageError && error.code === "PROVIDER_ERROR" && error.retryable,
  );
  await assert.rejects(
    submit,
    (error: unknown) => error instanceof ImageError && error.code === "INVALID_INPUT" && !error.retryable,
  );
  await assert.rejects(
    submit,
    (error: unknown) => error instanceof ImageError && error.code === "PROVIDER_ERROR" && !error.retryable,
  );
});

function signedWebhook(body: string, overrides: { timestamp?: string; tamper?: boolean } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x as string;
  const requestId = "req-abc";
  const userId = "user-1";
  const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
  const digest = createHash("sha256").update(body).digest("hex");
  const message = Buffer.from([requestId, userId, timestamp, digest].join("\n"));
  const signature = sign(null, message, privateKey).toString("hex");
  const headers = new Headers({
    "x-fal-webhook-request-id": requestId,
    "x-fal-webhook-user-id": userId,
    "x-fal-webhook-timestamp": timestamp,
    "x-fal-webhook-signature": overrides.tamper ? signature.replace(/^../, "00") : signature,
  });
  const fetcher = (async (url: string) => {
    assert.equal(url, JWKS_URL);
    return jsonResponse({ keys: [{ kty: "OKP", crv: "Ed25519", x }] });
  }) as unknown as typeof fetch;
  return { headers, fetcher };
}

test("a correctly signed webhook verifies and a tampered, stale or unsigned one does not", async () => {
  const body = JSON.stringify({ request_id: "req-abc", status: "OK" });
  const bytes = new TextEncoder().encode(body);

  resetJwksCache();
  const good = signedWebhook(body);
  assert.equal(await verifyFalWebhook(good.headers, bytes, { fetch: good.fetcher }), true);

  resetJwksCache();
  const tampered = signedWebhook(body, { tamper: true });
  assert.equal(await verifyFalWebhook(tampered.headers, bytes, { fetch: tampered.fetcher }), false);

  resetJwksCache();
  const otherBody = signedWebhook(body);
  assert.equal(
    await verifyFalWebhook(otherBody.headers, new TextEncoder().encode('{"request_id":"req-abc","status":"ERROR"}'), {
      fetch: otherBody.fetcher,
    }),
    false,
  );

  resetJwksCache();
  const stale = signedWebhook(body, { timestamp: String(Math.floor(Date.now() / 1000) - 3600) });
  assert.equal(await verifyFalWebhook(stale.headers, bytes, { fetch: stale.fetcher }), false);

  resetJwksCache();
  assert.equal(await verifyFalWebhook(new Headers(), bytes, { fetch: good.fetcher }), false);
});

test("a 403 from fal keeps fal's reason and does not claim the key was rejected", async () => {
  const { fetcher } = recorder([
    new Response('{"detail":"User is locked. Reason: Exhausted balance."}', { status: 403 }),
  ]);
  const provider = createFalProvider({ key: "k", fetch: fetcher });
  await assert.rejects(
    () =>
      provider.submit({
        model: MODELS["qwen-image"],
        prompt: "p",
        width: 512,
        height: 512,
        numImages: 1,
        outputFormat: "png",
      }),
    (error: unknown) =>
      error instanceof ImageError &&
      error.code === "PROVIDER_ERROR" &&
      !error.retryable &&
      error.message.includes("Exhausted balance") &&
      !error.message.includes("rejected the API key"),
  );
});
