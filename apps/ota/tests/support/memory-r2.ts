/**
 * In-memory implementation of the parts of `R2Bucket` that the media adapter uses (put, get with a
 * range, head, delete, list), so the workspace key prefix is exercised against real byte handling.
 */

interface Stored {
  bytes: Uint8Array;
  contentType: string;
}

export interface MemoryR2 {
  bucket: R2Bucket;
  objects: Map<string, Stored>;
}

async function toBytes(value: unknown): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (typeof value === "string") return new TextEncoder().encode(value);
  return new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

export function memoryR2(): MemoryR2 {
  const objects = new Map<string, Stored>();
  const bucket = {
    async put(key: string, value: unknown, options?: { httpMetadata?: { contentType?: string } }) {
      objects.set(key, { bytes: await toBytes(value), contentType: options?.httpMetadata?.contentType ?? "" });
      return { key };
    },
    async get(key: string, options?: { range?: { offset?: number; length?: number } }) {
      const found = objects.get(key);
      if (!found) return null;
      const range = options?.range;
      const offset = range?.offset ?? 0;
      const end =
        range?.length === undefined ? found.bytes.byteLength : Math.min(found.bytes.byteLength, offset + range.length);
      const slice = range ? found.bytes.slice(offset, end) : found.bytes;
      return {
        key,
        size: found.bytes.byteLength,
        httpMetadata: { contentType: found.contentType },
        range: range ? { offset, length: slice.byteLength } : undefined,
        body: streamOf(slice),
      };
    },
    async head(key: string) {
      const found = objects.get(key);
      return found ? { key, size: found.bytes.byteLength } : null;
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    async list(options?: { prefix?: string }) {
      const prefix = options?.prefix ?? "";
      return {
        objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
        truncated: false,
      };
    },
  };
  return { bucket: bucket as unknown as R2Bucket, objects };
}
