import { ImageError } from "./errors";
import { MAX_DIMENSION, MAX_IMAGES_PER_CALL, MIN_DIMENSION, type ModelSpec } from "./models";

/** Megapixels of one image, unrounded. */
export function megapixels(width: number, height: number): number {
  return (width * height) / 1_000_000;
}

/** The provider bills each started megapixel, so 0.999 MP is 1 MP and 1.57 MP is 2 MP. */
export function billedMegapixels(width: number, height: number): number {
  return Math.max(1, Math.ceil(megapixels(width, height) - 1e-9));
}

export interface PriceOverrides {
  /** Credits per megapixel by model id, from admin settings. */
  creditsPerMp?: Partial<Record<string, number>>;
}

export function creditsPerMp(model: ModelSpec, overrides?: PriceOverrides): number {
  const value = overrides?.creditsPerMp?.[model.id];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : model.creditsPerMp;
}

/** Credits for `count` images of one size on one model. */
export function creditsFor(
  model: ModelSpec,
  width: number,
  height: number,
  count: number,
  overrides?: PriceOverrides,
): number {
  return billedMegapixels(width, height) * creditsPerMp(model, overrides) * count;
}

/** Rejects sizes and counts the provider would refuse or that are not worth the risk. */
export function assertSize(model: ModelSpec, width: number, height: number, count: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new ImageError("INVALID_INPUT", "Width and height must be whole numbers.");
  }
  if (width < MIN_DIMENSION || height < MIN_DIMENSION || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new ImageError("INVALID_INPUT", `Width and height must be between ${MIN_DIMENSION} and ${MAX_DIMENSION}.`);
  }
  if (megapixels(width, height) > model.maxMp) {
    throw new ImageError("INVALID_INPUT", `${model.label} accepts at most ${model.maxMp} megapixels per image.`);
  }
  if (!Number.isInteger(count) || count < 1 || count > MAX_IMAGES_PER_CALL) {
    throw new ImageError("INVALID_INPUT", `num_images must be between 1 and ${MAX_IMAGES_PER_CALL}.`);
  }
}
