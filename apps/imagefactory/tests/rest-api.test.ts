import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "@templatedesign/platform/http";
import { z } from "zod";
import { readBody, restError, wantsWait } from "../src/lib/api/rest";
import { ImageError, type ImageErrorCode } from "../src/lib/images/errors";
import { editImageSchema, generateImageSchema } from "../src/lib/images/schemas";
import "../src/lib/platform";

const read = async (response: Response) => ({
  status: response.status,
  body: (await response.json()) as { error: { code: string; message: string; details?: unknown } },
});

test("each stable error code maps to its HTTP status", async () => {
  const expected: Record<ImageErrorCode, number> = {
    INSUFFICIENT_CREDITS: 402,
    INSUFFICIENT_SCOPE: 403,
    INVALID_INPUT: 422,
    NOT_FOUND: 404,
    PROVIDER_ERROR: 502,
    CONTENT_BLOCKED: 422,
    JOB_PENDING: 202,
  };
  for (const [code, status] of Object.entries(expected)) {
    const { status: actual, body } = await read(restError(new ImageError(code as ImageErrorCode, "message")));
    assert.equal(actual, status, code);
    assert.equal(body.error.code, code);
  }
});

test("platform errors and validation failures use the same envelope", async () => {
  const credits = await read(restError(new HttpError("insufficient_credits", 402, "Needs 8 credits.", { needed: 8 })));
  assert.equal(credits.status, 402);
  assert.equal(credits.body.error.code, "INSUFFICIENT_CREDITS");

  const parsed = generateImageSchema.safeParse({ prompt: "", tenant_id: "ten_b" });
  assert.equal(parsed.success, false);
  const validation = await read(restError(parsed.error as z.ZodError));
  assert.equal(validation.status, 422);
  assert.equal(validation.body.error.code, "VALIDATION_ERROR");
  assert.ok(JSON.stringify(validation.body.error.details).includes("tenant_id"));

  const unknown = await read(restError(new Error("boom")));
  assert.equal(unknown.status, 500);
  assert.equal(unknown.body.error.message, "The request could not be completed.");
});

test("request bodies are parsed strictly and an empty body is an empty object", async () => {
  const body = (value: string) => new Request("https://x.test", { method: "POST", body: value });
  assert.deepEqual(await readBody(body('{"prompt":"A bird"}'), generateImageSchema), {
    prompt: "A bird",
    num_images: 1,
  });
  await assert.rejects(() => readBody(body("not json"), generateImageSchema), ImageError);
  await assert.rejects(() => readBody(body(""), generateImageSchema), z.ZodError);
  await assert.rejects(() => readBody(body('{"instruction":"x","extra":1}'), editImageSchema), z.ZodError);
});

test("waiting is the default and ?wait=false turns it off", () => {
  assert.equal(wantsWait(new URL("https://x.test/api/v1/images/generate")), true);
  assert.equal(wantsWait(new URL("https://x.test/api/v1/images/generate?wait=true")), true);
  assert.equal(wantsWait(new URL("https://x.test/api/v1/images/generate?wait=false")), false);
});
