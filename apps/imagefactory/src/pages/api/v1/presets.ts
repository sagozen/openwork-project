import type { APIRoute } from "astro";
import { ok, rest } from "../../../lib/api/rest";
import { listPresets } from "../../../lib/images/service";

export const prerender = false;

export const GET: APIRoute = ({ request }) => rest(request, async (caller, deps) => ok(listPresets(deps, caller)));
