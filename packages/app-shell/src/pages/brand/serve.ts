import { runtimeEnv } from "@templatedesign/platform/runtime";
import type { APIRoute } from "astro";
import { serveBrandAsset } from "../../branding/serve";

export const prerender = false;

/** GET /brand/<workspaceId>/<hash>.<ext> — the logo objects `storeLogo` wrote. */
export const GET: APIRoute = async ({ params }) => {
  const bucket = (runtimeEnv() as unknown as { MEDIA: R2Bucket }).MEDIA;
  return serveBrandAsset(bucket, `brand/${params.path ?? ""}`);
};
