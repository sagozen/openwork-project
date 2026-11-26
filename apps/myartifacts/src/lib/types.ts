import type { PlatformEnv } from "@templatedesign/platform/types";

export type { AuthSession, AuthUser, Locale, Profile, RequestContext } from "@templatedesign/platform/types";

/**
 * MyArtifacts bindings = the platform bindings plus the S3-compatible object store. There is no R2
 * binding: files live in one private Contabo bucket and only metadata is kept in D1.
 */
export interface Env extends PlatformEnv {
  /** Object store endpoint, for example `https://usc1.contabostorage.com`. No trailing path. */
  S3_ENDPOINT: string;
  /** SigV4 signing region the endpoint accepts. */
  S3_REGION: string;
  S3_BUCKET: string;
  /** Secret: access key id of a key that can read, write and delete in `S3_BUCKET`. */
  S3_ACCESS_KEY_ID: string;
  /** Secret: the matching secret key. */
  S3_SECRET_ACCESS_KEY: string;
}
