import type { RecordReceptionResult } from "./types";

/**
 * Uses a mutation result only while it belongs to the request currently shown.
 * The result is absent on the route's first render and can briefly be stale after switching rows.
 */
export function resolveAcceptedSampleCode(
  result: RecordReceptionResult | undefined,
  selectedRequestCode: string | undefined,
): string | undefined {
  if (!result || result.requestCode !== selectedRequestCode) return undefined;
  return result.sample?.code;
}
