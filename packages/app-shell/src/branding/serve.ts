import { UPLOAD_CONTENT_SECURITY_POLICY } from "../security";
import { getObject } from "../storage/r2";
import { BRAND_KEY_PATTERN, CONTENT_TYPE_BY_EXTENSION } from "./upload";

/**
 * Serves `/brand/<key>`. The key is content-hashed so the response never changes and is cached
 * immutably. The content type comes from the key's extension, which `storeLogo` derived from the
 * file's magic bytes, never from anything the uploader sent. A sandbox CSP and `nosniff` mean the
 * file renders as an image or not at all.
 */
export async function serveBrandAsset(bucket: R2Bucket, key: string): Promise<Response> {
  if (!BRAND_KEY_PATTERN.test(key)) return new Response("Not found", { status: 404 });
  const extension = key.slice(key.lastIndexOf(".") + 1);
  const contentType = CONTENT_TYPE_BY_EXTENSION[extension];
  const object = contentType ? await getObject(bucket, key) : null;
  if (!object) return new Response("Not found", { status: 404 });
  return new Response(object.body, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": UPLOAD_CONTENT_SECURITY_POLICY,
      "cross-origin-resource-policy": "same-origin",
    },
  });
}
