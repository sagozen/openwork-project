import type { Db } from "@templatedesign/platform/db";
import { MAX_IMAGES_PER_CALL, MODELS, type ModelId } from "./models";
import type { PriceOverrides } from "./pricing";
import { DEFAULT_WORKER_WAIT_SECONDS, MAX_WORKER_WAIT_SECONDS } from "./workers";

/** Admin-editable behaviour. Every key is registered in `platform.ts` as an extra admin setting. */
export const SETTING_KEYS = {
  enabled: "generation.enabled",
  maxImages: "generation.max_images_per_call",
  ratePerMinute: "generation.rate_per_minute",
  workerWaitSeconds: "generation.worker_wait_seconds",
  price: (model: ModelId) => `pricing.${model}.credits_per_mp`,
} as const;

export const DEFAULT_RATE_PER_MINUTE = 30;

export interface ImageSettings {
  /** Kill switch: when false every generate and edit call is refused. */
  enabled: boolean;
  maxImagesPerCall: number;
  ratePerMinute: number;
  /** Seconds a job waits for a worker before the fallback provider takes it. */
  workerWaitSeconds: number;
  pricing: PriceOverrides;
}

export const DEFAULT_SETTINGS: ImageSettings = {
  enabled: true,
  maxImagesPerCall: MAX_IMAGES_PER_CALL,
  ratePerMinute: DEFAULT_RATE_PER_MINUTE,
  workerWaitSeconds: DEFAULT_WORKER_WAIT_SECONDS,
  pricing: {},
};

function parse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export async function loadImageSettings(db: Db): Promise<ImageSettings> {
  const keys = [
    SETTING_KEYS.enabled,
    SETTING_KEYS.maxImages,
    SETTING_KEYS.ratePerMinute,
    SETTING_KEYS.workerWaitSeconds,
    ...(Object.keys(MODELS) as ModelId[]).map(SETTING_KEYS.price),
  ];
  const rows = await db.all<{ key: string; value_json: string }>(
    `SELECT key, value_json FROM admin_settings WHERE key IN (${keys.map(() => "?").join(", ")})`,
    keys,
  );
  const values = new Map(rows.map((row) => [row.key, parse(row.value_json)]));
  const positive = (key: string, fallback: number, max: number) => {
    const value = values.get(key);
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
  };
  const creditsPerMp: Record<string, number> = {};
  for (const model of Object.keys(MODELS) as ModelId[]) {
    const value = values.get(SETTING_KEYS.price(model));
    if (typeof value === "number" && value > 0) creditsPerMp[model] = value;
  }
  return {
    enabled: values.get(SETTING_KEYS.enabled) !== false,
    maxImagesPerCall: positive(SETTING_KEYS.maxImages, DEFAULT_SETTINGS.maxImagesPerCall, MAX_IMAGES_PER_CALL),
    ratePerMinute: positive(SETTING_KEYS.ratePerMinute, DEFAULT_RATE_PER_MINUTE, 10_000),
    workerWaitSeconds: positive(SETTING_KEYS.workerWaitSeconds, DEFAULT_WORKER_WAIT_SECONDS, MAX_WORKER_WAIT_SECONDS),
    pricing: { creditsPerMp },
  };
}
