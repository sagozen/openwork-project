import type { PlatformEnv } from "@templatedesign/platform/types";

export type {
  AuthSession,
  AuthUser,
  CloudflareEmailBinding,
  Locale,
  Profile,
  RequestContext,
} from "@templatedesign/platform/types";

/**
 * ImageFactory bindings = the platform bindings plus the image bucket and the fal.ai key.
 * `IMAGE_PUBLIC_BASE` is the public prefix the Worker serves generated images from.
 */
export interface Env extends PlatformEnv {
  IMAGES: R2Bucket;
  /** fal.ai API key; every generation is billed to it. */
  FAL_KEY: string;
  IMAGE_PUBLIC_BASE: string;
}
