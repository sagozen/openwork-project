import type { APIRoute } from "astro";
import { invoke, readJsonObject, rest } from "../../../../lib/api/rest";

export const prerender = false;

/** Fetch a public https URL and store it. */
export const POST: APIRoute = (context) =>
  rest(context, async (caller, services) =>
    invoke("import_from_url", await readJsonObject(context.request), caller, services, 201),
  );
