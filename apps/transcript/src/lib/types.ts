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
 * TranscriptAnything bindings = the platform bindings plus media/result buckets, the R2 S3
 * credentials used to sign worker URLs, the transcription secrets and the LLM key.
 */
export interface Env extends PlatformEnv {
  MEDIA: R2Bucket;
  OUTPUTS: R2Bucket;
  /** S3 API credentials for `MEDIA`/`OUTPUTS`; only used to sign URLs. */
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  MEDIA_BUCKET_NAME?: string;
  OUTPUTS_BUCKET_NAME?: string;
  /** Shared secret for the cron sweep endpoint (platform pattern). */
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODELS?: string;
  /** Turnstile secret + site key for guest link previews and guest jobs. Set both or neither. */
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
}
