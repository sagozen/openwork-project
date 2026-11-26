import type { APIRoute } from "astro";
import { invoke, ok, queryObject, readBody, readJsonObject, rest } from "../../../../lib/api/rest";
import { ArtifactError } from "../../../../lib/artifacts/errors";
import type { PutBytesInput } from "../../../../lib/artifacts/schemas";
import { putBytes } from "../../../../lib/artifacts/service";

export const prerender = false;

export const GET: APIRoute = (context) =>
  rest(context, (caller, services) =>
    invoke("list_files", queryObject(new URL(context.request.url), { numbers: ["limit"] }), caller, services),
  );

/**
 * Save a small file. JSON (`{ name, content, encoding, ... }`) is the same call as `put_file`; a raw
 * `application/octet-stream` body takes its fields from the query (`?name=report.pdf&mime=...`).
 * Both are limited to the inline size.
 */
export const POST: APIRoute = (context) =>
  rest(context, async (caller, services) => {
    const { request } = context;
    const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type === "application/octet-stream") {
      // Unknown or malformed fields are rejected by the service's strict schema.
      const meta = queryObject(new URL(request.url), { numbers: ["expires_in_days"] }) as PutBytesInput;
      const bytes = await readBody(request, services.artifacts.settings.maxInlineBytes);
      return ok({ file: await putBytes(services.artifacts, caller, meta, bytes) }, 201);
    }
    if (type === "application/json" || type === "") {
      return invoke("put_file", await readJsonObject(request), caller, services, 201);
    }
    throw new ArtifactError("INVALID_INPUT", "Send the file as JSON or as an application/octet-stream body.");
  });
