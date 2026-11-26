import type { APIRoute } from "astro";
import { ok, rest } from "../../../lib/api/rest";
import { listBrandKits } from "../../../lib/images/service";

export const prerender = false;

export const GET: APIRoute = ({ request }) =>
  rest(request, async (caller, deps) => ok(await listBrandKits(deps, caller)));
