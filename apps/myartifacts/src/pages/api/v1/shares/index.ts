import type { APIRoute } from "astro";
import { invoke, queryObject, readJsonObject, rest } from "../../../../lib/api/rest";

export const prerender = false;

export const GET: APIRoute = (context) =>
  rest(context, (caller, services) =>
    invoke(
      "list_shares",
      queryObject(new URL(context.request.url), { numbers: ["limit"], booleans: ["include_revoked"] }),
      caller,
      services,
    ),
  );

export const POST: APIRoute = (context) =>
  rest(context, async (caller, services) =>
    invoke("create_share", await readJsonObject(context.request), caller, services, 201),
  );
