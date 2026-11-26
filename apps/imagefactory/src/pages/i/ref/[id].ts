import { d1Db } from "@templatedesign/platform/db";
import type { APIRoute } from "astro";
import { verifyReferenceSignature } from "../../../lib/images/storage";
import { runtimeEnv } from "../../../lib/runtime";

export const prerender = false;

const NOT_FOUND = () => new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });

/**
 * Short-lived link for a private brand reference asset. The image provider fetches it while an
 * edit runs; the signature expires after ten minutes and covers the asset id.
 */
export const GET: APIRoute = async ({ params, url }) => {
  const assetId = params.id ?? "";
  const env = runtimeEnv();
  const valid = await verifyReferenceSignature(
    env.BETTER_AUTH_SECRET,
    assetId,
    url.searchParams.get("exp"),
    url.searchParams.get("sig"),
  );
  if (!valid) return NOT_FOUND();
  const row = await d1Db(env.DB).first<{ r2_key: string; mime: string }>(
    "SELECT r2_key, mime FROM brand_assets WHERE id = ? AND deleted_at IS NULL",
    [assetId],
  );
  if (!row?.r2_key.startsWith("brand/")) return NOT_FOUND();
  const object = await env.IMAGES.get(row.r2_key);
  if (!object) return NOT_FOUND();
  return new Response(object.body, {
    headers: {
      "content-type": row.mime,
      "content-length": String(object.size),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
};
