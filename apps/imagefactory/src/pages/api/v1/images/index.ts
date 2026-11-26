import type { APIRoute } from "astro";
import { ok, rest } from "../../../../lib/api/rest";
import { listImagesSchema } from "../../../../lib/images/schemas";
import { listImages } from "../../../../lib/images/service";

export const prerender = false;

export const GET: APIRoute = ({ request, url }) =>
  rest(request, async (caller, deps) => {
    const query = Object.fromEntries(url.searchParams);
    const input = listImagesSchema.parse({ ...query, ...(query.limit ? { limit: Number(query.limit) } : {}) });
    return ok(await listImages(deps, caller, input));
  });
