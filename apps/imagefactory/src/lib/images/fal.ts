import { ImageError } from "./errors";
import type {
  ImageProvider,
  ProviderImage,
  ProviderJob,
  ProviderRequest,
  ProviderResult,
  ProviderStatus,
} from "./provider";

const QUEUE_BASE = "https://queue.fal.run";

export interface FalOptions {
  key: string;
  fetch?: typeof fetch;
}

interface FalSubmitResponse {
  request_id: string;
  status_url: string;
  response_url: string;
  cancel_url?: string;
}

interface FalStatusResponse {
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";
  queue_position?: number;
}

interface FalImage {
  url: string;
  width?: number;
  height?: number;
  content_type?: string;
}

interface FalResultResponse {
  images?: FalImage[];
  seed?: number;
  has_nsfw_concepts?: boolean[];
}

/** 429 and 5xx are worth retrying; other 4xx mean the request itself is wrong. */
function failure(status: number, body: string, what: string): ImageError {
  const detail = body.slice(0, 300);
  if (status === 429 || status >= 500) {
    return new ImageError("PROVIDER_ERROR", `fal.ai ${what} failed (${status}). ${detail}`.trim(), true);
  }
  if (status === 401) {
    return new ImageError("PROVIDER_ERROR", `fal.ai rejected the API key. ${detail}`.trim(), false);
  }
  if (status === 403) {
    // fal answers 403 for a locked account or an exhausted balance as well as for a key without access.
    return new ImageError(
      "PROVIDER_ERROR",
      `fal.ai refused the request (403): the key may lack access or the fal account may be locked or out of balance. ${detail}`.trim(),
      false,
    );
  }
  return new ImageError("INVALID_INPUT", `fal.ai rejected the request (${status}). ${detail}`.trim(), false);
}

/** fal.ai queue API over plain `fetch`: no SDK, so nothing extra in the Worker bundle. */
export function createFalProvider(options: FalOptions): ImageProvider {
  const doFetch = options.fetch ?? fetch;
  const headers = (extra: Record<string, string> = {}) => ({
    authorization: `Key ${options.key}`,
    "content-type": "application/json",
    // No request history on fal's side, and a short object lifetime: results are copied to R2.
    "x-fal-store-io": "0",
    "x-fal-object-lifecycle-preference": JSON.stringify({ expiration_duration_seconds: 3600 }),
    ...extra,
  });

  async function call(url: string, init: RequestInit, what: string): Promise<Response> {
    let response: Response;
    try {
      response = await doFetch(url, init);
    } catch (error) {
      throw new ImageError(
        "PROVIDER_ERROR",
        `fal.ai ${what} could not be reached: ${error instanceof Error ? error.message : "network error"}`,
        true,
      );
    }
    if (!response.ok) throw failure(response.status, await response.text().catch(() => ""), what);
    return response;
  }

  return {
    id: "fal",

    async submit(request: ProviderRequest): Promise<ProviderJob> {
      const body: Record<string, unknown> = {
        prompt: request.prompt,
        image_size: { width: request.width, height: request.height },
        num_images: request.numImages,
        output_format: request.outputFormat,
        enable_safety_checker: request.enableSafetyChecker ?? true,
        // Plain acceleration keeps small text legible; the faster modes smudge it.
        acceleration: "regular",
      };
      if (request.negativePrompt) body.negative_prompt = request.negativePrompt;
      if (request.seed !== undefined) body.seed = request.seed;
      if (request.imageUrls?.length) body.image_urls = request.imageUrls;

      const query = request.webhookUrl ? `?fal_webhook=${encodeURIComponent(request.webhookUrl)}` : "";
      const response = await call(
        `${QUEUE_BASE}/${request.model.endpoint}${query}`,
        { method: "POST", headers: headers(), body: JSON.stringify(body) },
        "submit",
      );
      const data = (await response.json()) as FalSubmitResponse;
      if (!data.request_id || !data.status_url || !data.response_url) {
        throw new ImageError("PROVIDER_ERROR", "fal.ai returned an unexpected submit response.", true);
      }
      return {
        providerJobId: data.request_id,
        statusUrl: data.status_url,
        responseUrl: data.response_url,
        cancelUrl: data.cancel_url,
      };
    },

    async status(job): Promise<ProviderStatus> {
      const response = await call(job.statusUrl, { method: "GET", headers: headers() }, "status");
      const data = (await response.json()) as FalStatusResponse;
      if (data.status === "COMPLETED") return { state: "done" };
      if (data.status === "IN_PROGRESS") return { state: "running" };
      return { state: "queued", queuePosition: data.queue_position };
    },

    async result(job): Promise<ProviderResult> {
      const response = await call(job.responseUrl, { method: "GET", headers: headers() }, "result");
      const data = (await response.json()) as FalResultResponse;
      const flags = data.has_nsfw_concepts ?? [];
      const images: ProviderImage[] = (data.images ?? []).map((image, index) => ({
        url: image.url,
        width: image.width ?? 0,
        height: image.height ?? 0,
        contentType: image.content_type ?? "image/png",
        blocked: flags[index] === true,
      }));
      if (images.length === 0) throw new ImageError("PROVIDER_ERROR", "fal.ai returned no images.", false);
      return { images, seed: typeof data.seed === "number" ? data.seed : null };
    },

    async cancel(job): Promise<void> {
      if (!job.cancelUrl) return;
      await doFetch(job.cancelUrl, { method: "PUT", headers: headers() }).catch(() => undefined);
    },
  };
}
