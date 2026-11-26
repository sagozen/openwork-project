import type { PlatformEnv } from "@templatedesign/platform/types";

export type { AuthSession, AuthUser, Locale, Profile, RequestContext } from "@templatedesign/platform/types";

/** Ota bindings = the platform bindings plus the media bucket and the OTA knobs. */
export interface Env extends PlatformEnv {
  /** Shared bucket for bundles; every workspace writes below its own key prefix. */
  MEDIA: R2Bucket;
  /** 32-byte key (64 hex characters or base64) that encrypts bring-your-own bucket secrets. */
  OTA_SECRET_KEY?: string;
  /** Deployment ceiling for one bundle, in bytes. A plan can only lower it. */
  OTA_MAX_BUNDLE_BYTES?: string;
  /** Default retention window in days for workspaces that did not choose one. */
  OTA_RETENTION_DAYS?: string;
}
