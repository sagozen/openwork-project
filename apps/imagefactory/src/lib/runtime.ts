import { runtimeEnv as runtimeEnvBase, waitUntil } from "@templatedesign/platform/runtime";
import type { Env } from "./types";

/** Cloudflare bindings for the current request, typed with Imagefactory's extension. */
export function runtimeEnv(): Env {
  return runtimeEnvBase<Env>();
}

export { waitUntil };
