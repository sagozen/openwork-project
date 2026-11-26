/**
 * Blob storage backed by the platform's own storage adapter (the shared media bucket, see
 * `media.ts`). The adapter is used structurally, so this module depends on no runtime binding.
 */

import { BUNDLE_CONTENT_TYPE, OtaError } from "../domain/data.js";
import type { BlobRead, OtaBlobStore, PlatformStorage } from "../domain/types.js";

export function platformBlobStore(storage: PlatformStorage): OtaBlobStore {
  async function read(key: string, range?: { offset: number; length?: number }): Promise<BlobRead | null> {
    if (!(await storage.exists(key))) return null;
    const result = await storage.download(
      key,
      range
        ? {
            range:
              range.length === undefined ? { offset: range.offset } : { offset: range.offset, length: range.length },
          }
        : undefined,
    );
    return {
      body: result.body,
      contentType: result.contentType || BUNDLE_CONTENT_TYPE,
      size: result.size,
      ...(result.range ? { range: result.range } : {}),
    };
  }

  return {
    describe() {
      return "platform storage (shared media bucket)";
    },

    async put(key, bytes, options = {}) {
      try {
        await storage.upload({
          key,
          body: bytes,
          contentType: options.contentType ?? BUNDLE_CONTENT_TYPE,
          cacheControl: options.cacheControl,
        });
      } catch (error) {
        throw new OtaError(
          "STORAGE_FAILED",
          `The site storage rejected the upload${error instanceof Error && error.message ? `: ${error.message}` : "."}`,
          502,
        );
      }
    },

    async get(key, range) {
      return read(key, range);
    },

    async head(key) {
      const result = await read(key);
      if (!result) return null;
      await result.body.cancel().catch(() => undefined);
      return { size: result.size, contentType: result.contentType };
    },

    async delete(key) {
      await storage.delete(key);
    },
  };
}
