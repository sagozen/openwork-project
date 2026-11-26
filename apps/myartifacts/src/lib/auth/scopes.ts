import { ArtifactError } from "../artifacts/errors";
import type { Caller } from "./caller";

export const SCOPE_READ = "artifacts:read";
export const SCOPE_WRITE = "artifacts:write";

/** A write grant implies read: a client that may store files may also look at what it stored. */
export function hasScope(caller: Pick<Caller, "scopes">, scope: string): boolean {
  return caller.scopes.includes(scope) || (scope === SCOPE_READ && caller.scopes.includes(SCOPE_WRITE));
}

export function assertScope(caller: Pick<Caller, "scopes">, scope: string): void {
  if (!hasScope(caller, scope)) {
    throw new ArtifactError("INSUFFICIENT_SCOPE", `This connection does not have the ${scope} permission.`, {
      required: scope,
    });
  }
}
