import type { APIRoute } from "astro";
import { invoke, rest } from "../../../../../lib/api/rest";

export const prerender = false;

/** Finish a presigned upload after the bytes were PUT. */
export const POST: APIRoute = (context) =>
  rest(context, (caller, services) =>
    invoke("complete_upload", { file_id: context.params.id ?? "" }, caller, services),
  );
