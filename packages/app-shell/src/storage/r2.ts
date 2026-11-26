/** Thin R2 helpers. Workspace files live under a prefix that starts with the workspace id. */

export async function putObject(
  bucket: R2Bucket,
  key: string,
  body: ArrayBuffer | Uint8Array | string,
  contentType: string,
): Promise<void> {
  await bucket.put(key, body, { httpMetadata: { contentType } });
}

export async function getObject(bucket: R2Bucket, key: string): Promise<R2ObjectBody | null> {
  return bucket.get(key);
}

export async function deleteObject(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(key);
}

/** Deletes everything under `prefix`, a page at a time. Returns how many objects were removed. */
export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let removed = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    if (page.objects.length > 0) {
      await bucket.delete(page.objects.map((object) => object.key));
      removed += page.objects.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return removed;
}
