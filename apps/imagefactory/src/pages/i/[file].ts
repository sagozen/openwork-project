import { d1Db } from "@templatedesign/platform/db";
import type { APIRoute } from "astro";
import { IMAGE_ID_PATTERN, mimeForExtension } from "../../lib/images/storage";
import { runtimeEnv } from "../../lib/runtime";

export const prerender = false;

const NOT_FOUND = () => new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });

interface ImageLookup {
  r2_key: string;
  mime: string;
}

/**
 * Public image host. The id is 128 random bits, so the URL is the only capability; there is no
 * tenant check by design. Only keys under `images/` are ever served: brand reference assets live
 * under another prefix and are reachable only through a signed link.
 */
export const GET: APIRoute = async ({ params }) => {
  const match = /^([a-z2-7]{26})\.(png|jpg|jpeg|webp)$/.exec(params.file ?? "");
  if (!match || !IMAGE_ID_PATTERN.test(match[1])) return NOT_FOUND();
  const env = runtimeEnv();
  const row = await d1Db(env.DB).first<ImageLookup>(
    "SELECT r2_key, mime FROM images WHERE id = ? AND deleted_at IS NULL",
    [match[1]],
  );
  if (!row?.r2_key.startsWith("images/")) return NOT_FOUND();
  // The extension in the URL must match what was stored, so one id has one canonical URL.
  if (mimeForExtension(match[2]) !== row.mime) return NOT_FOUND();
  const object = await env.IMAGES.get(row.r2_key);
  if (!object) return NOT_FOUND();
  return new Response(object.body, {
    headers: {
      "content-type": row.mime,
      "content-length": String(object.size),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
      etag: object.httpEtag,
    },
  });
};
