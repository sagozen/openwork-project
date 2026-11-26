import type { APIRoute } from "astro";
import { ok, readBody, rest, wantsWait } from "../../../../lib/api/rest";
import { generateImageSchema } from "../../../../lib/images/schemas";
import { generateImages } from "../../../../lib/images/service";

export const prerender = false;

/** Same call as the `generate_image` tool. `?wait=false` returns 202 and a job id straight away. */
export const POST: APIRoute = ({ request, url }) =>
  rest(request, async (caller, deps) => {
    const input = await readBody(request, generateImageSchema);
    const result = await generateImages(deps, caller, input, { wait: wantsWait(url) });
    return ok(result, result.pending ? 202 : 200);
  });
