import type { APIRoute } from "astro";
import { invoke, readJsonObject, rest } from "../../../../lib/api/rest";

export const prerender = false;

export const GET: APIRoute = (context) =>
  rest(context, (caller, services) => invoke("get_share", { share_id: context.params.id ?? "" }, caller, services));

export const PATCH: APIRoute = (context) =>
  rest(context, async (caller, services) =>
    invoke(
      "update_share",
      { ...(await readJsonObject(context.request)), share_id: context.params.id ?? "" },
      caller,
      services,
    ),
  );

/** DELETE revokes the share; the files stay. */
export const DELETE: APIRoute = (context) =>
  rest(context, (caller, services) => invoke("revoke_share", { share_id: context.params.id ?? "" }, caller, services));
