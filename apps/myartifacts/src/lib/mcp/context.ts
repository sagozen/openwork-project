import { type ArtifactDeps, artifactDeps } from "../artifacts/service";
import { type ShareDeps, shareDeps } from "../shares/service";
import type { Env } from "../types";

/** Everything a tool or REST route needs for one request. */
export interface ServiceContext {
  /** Bindings, used to authenticate REST callers. */
  env: Env;
  artifacts: ArtifactDeps;
  /** Share URLs in tool output are built from `APP_ORIGIN`, never from the origin of the request. */
  shares: ShareDeps;
}

/**
 * Service dependencies for the current request: bindings, settings and the storage client. The
 * Workers runtime module is loaded on demand so tests can swap the factory without it.
 */
let factory: () => Promise<ServiceContext> = async () => {
  const { runtimeEnv } = await import("../runtime");
  const env = runtimeEnv();
  return { env, artifacts: await artifactDeps(env), shares: shareDeps(env) };
};

export function serviceFor(): Promise<ServiceContext> {
  return factory();
}

/** Test seam: replaces how a request gets its service dependencies. */
export function setServiceFactory(next: () => Promise<ServiceContext>): void {
  factory = next;
}
