import { type ServiceDeps, serviceDeps } from "../images/service";

/**
 * Service dependencies for the current request: bindings, settings and signing secret. The Workers
 * runtime module is loaded on demand so tests can swap the factory without it.
 */
let factory: () => Promise<ServiceDeps> = async () => {
  const { runtimeEnv } = await import("../runtime");
  return serviceDeps(runtimeEnv());
};

export function serviceFor(): Promise<ServiceDeps> {
  return factory();
}

/** Test seam: replaces how a request gets its service dependencies. */
export function setServiceFactory(next: () => Promise<ServiceDeps>): void {
  factory = next;
}
