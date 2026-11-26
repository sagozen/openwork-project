/**
 * Platform storage over the `MEDIA` R2 binding.
 *
 * One bucket serves every workspace, so each workspace gets its own key prefix; a bundle key from
 * one workspace can never address an object of another.
 */

import type { PlatformStorage } from "../domain/types.js";

export function mediaPlatformStorage(bucket: R2Bucket, prefix: string): PlatformStorage {
  const full = (key: string) => `${prefix}${key}`;
  return {
    async upload({ key, body, contentType, cacheControl }) {
      await bucket.put(full(key), body, {
        httpMetadata: { contentType, ...(cacheControl ? { cacheControl } : {}) },
      });
      return { key };
    },

    async download(key, options) {
      const wanted = options?.range;
      const object = await bucket.get(full(key), wanted ? { range: wanted } : undefined);
      if (!object || !("body" in object)) throw new Error(`Object not found: ${key}`);
      const contentType = object.httpMetadata?.contentType ?? "";
      if (!wanted) return { body: object.body, contentType, size: object.size };
      const offset = object.range && "offset" in object.range ? (object.range.offset ?? 0) : 0;
      const length =
        object.range && "length" in object.range && object.range.length !== undefined
          ? object.range.length
          : object.size - offset;
      return { body: object.body, contentType, size: object.size, range: { offset, length } };
    },

    async delete(key) {
      await bucket.delete(full(key));
    },

    async exists(key) {
      return (await bucket.head(full(key))) !== null;
    },
  };
}

/** Key prefix for one workspace's objects in the shared media bucket. */
export function workspaceMediaPrefix(workspaceId: string): string {
  return `ota/${workspaceId}/`;
}

/** Removes every object a workspace stored, page by page. Safe to repeat. */
export async function deleteWorkspaceObjects(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 500 });
    if (page.objects.length > 0) await bucket.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
