import type { ModelSpec } from "./models";

export interface ProviderRequest {
  model: ModelSpec;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  numImages: number;
  seed?: number;
  /** Absolute URLs the provider can fetch. Required for edit models. */
  imageUrls?: string[];
  outputFormat: "png" | "jpeg" | "webp";
  /** Public HTTPS URL the provider calls when the job finishes. */
  webhookUrl?: string;
  enableSafetyChecker?: boolean;
}

export interface ProviderJob {
  providerJobId: string;
  statusUrl: string;
  responseUrl: string;
  cancelUrl?: string;
}

export interface ProviderStatus {
  state: "queued" | "running" | "done";
  queuePosition?: number;
}

export interface ProviderImage {
  url: string;
  width: number;
  height: number;
  contentType: string;
  /** The provider's safety checker flagged this image (it comes back black). */
  blocked: boolean;
}

export interface ProviderResult {
  images: ProviderImage[];
  seed: number | null;
}

/** What the job service needs from an image provider. Only fal ships in the first release. */
export interface ImageProvider {
  readonly id: "fal";
  submit(request: ProviderRequest): Promise<ProviderJob>;
  status(job: Pick<ProviderJob, "statusUrl">): Promise<ProviderStatus>;
  result(job: Pick<ProviderJob, "responseUrl">): Promise<ProviderResult>;
  cancel?(job: Pick<ProviderJob, "cancelUrl">): Promise<void>;
}
