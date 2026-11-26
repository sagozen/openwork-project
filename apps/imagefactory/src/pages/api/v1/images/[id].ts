import type { APIRoute } from "astro";
import { ok, rest } from "../../../../lib/api/rest";
import { deleteImageById, getImageDetail } from "../../../../lib/images/service";

export const prerender = false;

export const GET: APIRoute = ({ request, params }) =>
  rest(request, async (caller, deps) => ok(await getImageDetail(deps, caller, params.id ?? "")));

export const DELETE: APIRoute = ({ request, params }) =>
  rest(request, async (caller, deps) => ok(await deleteImageById(deps, caller, params.id ?? "")));
