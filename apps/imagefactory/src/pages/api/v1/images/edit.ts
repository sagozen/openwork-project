import type { APIRoute } from "astro";
import { ok, readBody, rest, wantsWait } from "../../../../lib/api/rest";
import { editImageSchema } from "../../../../lib/images/schemas";
import { editImages } from "../../../../lib/images/service";

export const prerender = false;

/** Same call as the `edit_image` tool. */
export const POST: APIRoute = ({ request, url }) =>
  rest(request, async (caller, deps) => {
    const input = await readBody(request, editImageSchema);
    const result = await editImages(deps, caller, input, { wait: wantsWait(url) });
    return ok(result, result.pending ? 202 : 200);
  });
