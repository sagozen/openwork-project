import { tenantPrefixes } from "./storage";

/** Removes every object a tenant owns: generated images and private brand assets. Idempotent. */
export async function deleteTenantObjects(bucket: R2Bucket, tenantId: string): Promise<number> {
  let removed = 0;
  for (const prefix of tenantPrefixes(tenantId)) {
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix, cursor, limit: 500 });
      if (page.objects.length > 0) {
        await bucket.delete(page.objects.map((object) => object.key));
        removed += page.objects.length;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  return removed;
}
