import { HttpError, json } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { completeWorkerJob } from "../../../../../../lib/images/worker-jobs";
import { jobIdFrom, withWorker } from "../../_context";

export const prerender = false;

interface CompleteMeta {
  lease_token?: string;
  seed?: number | null;
  /** The generator the agent used, for example "gpt-image-1". */
  model?: string;
}

/**
 * `POST …/complete` — multipart form: a `meta` JSON field (`lease_token`, optional `seed`, `model`) and one
 * file per image named `image0`, `image1`, … Idempotent for the lease holder: the first completion settles
 * the credits; a lost lease answers 409 and changes nothing.
 */
export const POST: APIRoute = async (context) =>
  withWorker(context, async ({ worker, jobs }) => {
    let form: FormData;
    try {
      form = await context.request.formData();
    } catch {
      throw new HttpError("invalid_input", 400, "Send multipart/form-data with a meta field and image files.");
    }
    let meta: CompleteMeta;
    try {
      meta = JSON.parse(String(form.get("meta") ?? "")) as CompleteMeta;
    } catch {
      throw new HttpError("invalid_input", 400, "The meta field must be JSON.");
    }
    const images: Array<{ bytes: Uint8Array }> = [];
    for (let index = 0; index < 8; index += 1) {
      const file = form.get(`image${index}`);
      if (!file || typeof file === "string") break;
      images.push({ bytes: new Uint8Array(await file.arrayBuffer()) });
    }
    const result = await completeWorkerJob(await jobs(), worker, jobIdFrom(context), {
      leaseToken: meta.lease_token,
      seed: typeof meta.seed === "number" ? meta.seed : null,
      model: typeof meta.model === "string" ? meta.model : undefined,
      images,
    });
    if (result.accepted) {
      return json({
        accepted: true,
        job: { id: result.job.id, state: result.job.state, credits_charged: result.job.credits_charged },
      });
    }
    const status = result.reason === "unknown_job" ? 404 : result.reason === "invalid_images" ? 400 : 409;
    return json(result, { status });
  });
