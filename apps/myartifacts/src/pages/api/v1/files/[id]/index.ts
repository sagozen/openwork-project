import type { APIRoute } from "astro";
import { invoke, readJsonObject, rest } from "../../../../../lib/api/rest";

export const prerender = false;

export const GET: APIRoute = (context) =>
  rest(context, (caller, services) => invoke("get_file", { file_id: context.params.id ?? "" }, caller, services));

/** Set or clear (`{ "expires_in_days": null }`) the day the file is removed. */
export const PATCH: APIRoute = (context) =>
  rest(context, async (caller, services) =>
    invoke(
      "set_file_expiry",
      { ...(await readJsonObject(context.request)), file_id: context.params.id ?? "" },
      caller,
      services,
    ),
  );

export const DELETE: APIRoute = (context) =>
  rest(context, (caller, services) => invoke("delete_file", { file_id: context.params.id ?? "" }, caller, services));
