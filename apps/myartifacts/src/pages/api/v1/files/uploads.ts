import type { APIRoute } from "astro";
import { invoke, readJsonObject, rest } from "../../../../lib/api/rest";

export const prerender = false;

/** Start a presigned upload: declare the name and size, get a URL to PUT the bytes to. */
export const POST: APIRoute = (context) =>
  rest(context, async (caller, services) =>
    invoke("create_upload", await readJsonObject(context.request), caller, services, 201),
  );
