import type { StorageCollection } from "emdash";
import type { Result } from "../model.js";
import { DomainError } from "../validation.js";

// This is a subset of EmDash 1.2.0's actual public collection API, not a database adapter.
export type DomainCollection = Pick<
  StorageCollection,
  "getVersioned" | "compareAndSet" | "query" | "put" | "updateIf"
>;
export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export function secret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export async function result<T>(
  operation: () => Promise<T>,
): Promise<Result<T>> {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    // Expected failures are DomainErrors; anything else is a bug to see in logs.
    if (!(error instanceof DomainError))
      console.error("[mytutor-lms] unexpected error", error);
    return {
      ok: false,
      error:
        error instanceof DomainError
          ? {
              code: error.code,
              message: error.message,
              ...(error.details ? { details: error.details } : {}),
            }
          : {
              code: "INTERNAL",
              message: "The request could not be completed. Please try again.",
            },
    };
  }
}
export async function all(
  collection: DomainCollection,
  where?: Record<string, string | number | boolean | null>,
): Promise<Array<{ id: string; data: unknown }>> {
  const rows: Array<{ id: string; data: unknown }> = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await collection.query({
      where,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    rows.push(...page.items);
    if (!page.hasMore) return rows;
    if (!page.cursor || seen.has(page.cursor))
      throw new Error("Invalid storage pagination");
    seen.add(page.cursor);
    cursor = page.cursor;
  } while (cursor);
  return rows;
}

/** Deterministic record key from structured parts. */
export function key(...parts: unknown[]): Promise<string> {
  return digest(JSON.stringify(parts));
}
/** Equal-time comparison of two hex digests. */
export function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++)
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}
