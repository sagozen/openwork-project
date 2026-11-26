import { d1Db } from "@templatedesign/platform/db";
import type { Env } from "../types";
import { createFalProvider } from "./fal";
import type { JobContext } from "./jobs";
import type { PriceOverrides } from "./pricing";
import { signedReferenceUrl } from "./storage";

/** The job context for one request, built from the Worker bindings. */
export function jobContext(env: Env, overrides: { pricing?: PriceOverrides } = {}): JobContext {
  return {
    db: d1Db(env.DB),
    images: env.IMAGES,
    provider: createFalProvider({ key: env.FAL_KEY }),
    signReference: (assetId) => signedReferenceUrl(env.APP_ORIGIN, env.BETTER_AUTH_SECRET, assetId),
    publicBase: env.IMAGE_PUBLIC_BASE,
    webhookUrl: `${env.APP_ORIGIN.replace(/\/$/, "")}/api/v1/fal-webhook`,
    pricing: overrides.pricing,
  };
}
