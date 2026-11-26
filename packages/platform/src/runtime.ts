import { env, waitUntil } from "cloudflare:workers";
import type { PlatformEnv } from "./types";

/**
 * Cloudflare bindings for the current request (Astro v7 removes `locals.runtime`).
 * Each app parameterises the type with its own `Env` extension:
 * `runtimeEnv<Env>()`.
 */
export function runtimeEnv<E extends PlatformEnv = PlatformEnv>(): E {
  return env as unknown as E;
}

export { waitUntil };
