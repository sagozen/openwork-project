/**
 * The model registry. A logical model name maps to a provider endpoint, the parameters it accepts
 * and its price. Adding another provider later means a row here plus an adapter.
 */
export type ModelId = "qwen-image" | "qwen-edit";

export interface ModelSpec {
  id: ModelId;
  provider: "fal";
  endpoint: string;
  kind: "generate" | "edit";
  label: string;
  /** What the provider bills per started megapixel, in US dollars. */
  providerUsdPerMp: number;
  /** Default credits charged per started megapixel; an admin setting can override it. */
  creditsPerMp: number;
  /** Largest output the endpoint accepts, in megapixels. */
  maxMp: number;
  /** Reference images an edit call needs (min and max). */
  referenceImages?: { min: number; max: number };
}

export const MODELS: Record<ModelId, ModelSpec> = {
  "qwen-image": {
    id: "qwen-image",
    provider: "fal",
    endpoint: "fal-ai/qwen-image-2512",
    kind: "generate",
    label: "Qwen Image 2512 (text to image)",
    providerUsdPerMp: 0.02,
    creditsPerMp: 4,
    maxMp: 4,
  },
  "qwen-edit": {
    id: "qwen-edit",
    provider: "fal",
    endpoint: "fal-ai/qwen-image-edit-2511",
    kind: "edit",
    label: "Qwen Image Edit 2511 (reference-based edits)",
    providerUsdPerMp: 0.03,
    creditsPerMp: 6,
    maxMp: 4,
    referenceImages: { min: 1, max: 3 },
  },
};

export const MAX_IMAGES_PER_CALL = 4;
export const MIN_DIMENSION = 256;
export const MAX_DIMENSION = 2048;

export function isModelId(value: unknown): value is ModelId {
  return typeof value === "string" && value in MODELS;
}

export function modelSpec(id: string): ModelSpec | undefined {
  return isModelId(id) ? MODELS[id] : undefined;
}
