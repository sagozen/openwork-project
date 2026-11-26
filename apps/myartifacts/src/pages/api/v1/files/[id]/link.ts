import type { APIRoute } from "astro";
import { invoke, queryObject, rest } from "../../../../../lib/api/rest";

export const prerender = false;

/** A presigned download link. `?ttl=` is in seconds (60 to 604800); `?disposition=inline|attachment`. */
export const GET: APIRoute = (context) =>
  rest(context, (caller, services) =>
    invoke(
      "get_download_link",
      {
        file_id: context.params.id ?? "",
        ...queryObject(new URL(context.request.url), { numbers: ["ttl_seconds"], rename: { ttl: "ttl_seconds" } }),
      },
      caller,
      services,
    ),
  );
