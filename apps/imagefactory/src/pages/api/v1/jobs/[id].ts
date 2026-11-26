import type { APIRoute } from "astro";
import { ok, rest } from "../../../../lib/api/rest";
import { getJobResult } from "../../../../lib/images/service";

export const prerender = false;

/** Same call as the `get_job` tool: 202 while the job runs, 200 with the images when it is done. */
export const GET: APIRoute = ({ request, params }) =>
  rest(request, async (caller, deps) => {
    const result = await getJobResult(deps, caller, params.id ?? "");
    return ok(result, result.pending ? 202 : 200);
  });
