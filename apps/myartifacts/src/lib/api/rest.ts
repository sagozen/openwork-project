import { HttpError } from "@templatedesign/platform/http";
import { z } from "zod";
import { ArtifactError, type ArtifactErrorCode } from "../artifacts/errors";
import { readBounded } from "../artifacts/service";
import { type Caller, withCaller } from "../auth/caller";
import { SCOPE_READ, SCOPE_WRITE } from "../auth/scopes";
import { type ServiceContext, serviceFor } from "../mcp/context";
import { TOOLS } from "../mcp/server";
import { callTool, type ToolDefinition } from "../mcp/tool";

/** The same stable codes the MCP tools return, as HTTP statuses. */
const STATUS: Record<ArtifactErrorCode, number> = {
  NOT_FOUND: 404,
  UPLOAD_NOT_FOUND: 404,
  INSUFFICIENT_SCOPE: 403,
  INVALID_INPUT: 422,
  VALIDATION_ERROR: 422,
  TOO_LARGE: 413,
  UPLOADS_DISABLED: 503,
  PROVIDER_ERROR: 502,
  INTERNAL_ERROR: 500,
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function body(code: string, message: string, details?: unknown): string {
  return JSON.stringify({ error: { code, message, ...(details ? { details } : {}) } });
}

export function restError(error: unknown): Response {
  if (error instanceof ArtifactError) {
    return new Response(body(error.code, error.message, error.details), {
      status: STATUS[error.code],
      headers: JSON_HEADERS,
    });
  }
  if (error instanceof z.ZodError) {
    const fields = error.issues.map(({ path, message }) => ({ path: path.join("."), message }));
    return new Response(body("VALIDATION_ERROR", "Correct the indicated fields and retry.", fields), {
      status: 422,
      headers: JSON_HEADERS,
    });
  }
  if (error instanceof HttpError) {
    return new Response(body(error.code.toUpperCase(), error.message, error.details), {
      status: error.status,
      headers: JSON_HEADERS,
    });
  }
  console.error("[api] Request failed", error instanceof Error ? error.message : "unknown");
  return new Response(body("INTERNAL_ERROR", "The request could not be completed."), {
    status: 500,
    headers: JSON_HEADERS,
  });
}

export function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

/** The slice of Astro's route context a REST handler needs: the request and what the middleware resolved. */
export interface RestContext {
  request: Request;
  locals?: { user?: { id: string }; tenantId?: string };
}

/**
 * Runs a REST handler for an authenticated caller. A bearer token (API key) goes through the same
 * `withCaller` the MCP endpoint uses, so the owner check behind it applies on both. With no bearer
 * header, the owner's browser session is accepted: the middleware only sets `locals.user` for the
 * owner and already demanded the CSRF token for anything that is not a read, so the account page
 * can call these routes directly.
 */
export async function rest(
  context: RestContext,
  handler: (caller: Caller, services: ServiceContext) => Promise<Response>,
): Promise<Response> {
  const services = await serviceFor();
  const run = async (caller: Caller) => {
    try {
      return await handler(caller, services);
    } catch (error) {
      return restError(error);
    }
  };
  const { request, locals } = context;
  if (!request.headers.has("authorization") && locals?.user && locals.tenantId) {
    return run({
      tenantId: locals.tenantId,
      userId: locals.user.id,
      scopes: [SCOPE_READ, SCOPE_WRITE],
      via: "session",
    });
  }
  return withCaller(services.env, request, run);
}

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function tool(name: string): ToolDefinition {
  const found = TOOLS_BY_NAME.get(name);
  if (!found) throw new Error(`Unknown tool ${name}`);
  return found;
}

/** Runs a tool by name with the REST input and answers with its data, so a route and its tool cannot drift apart. */
export async function invoke(
  name: string,
  input: unknown,
  caller: Caller,
  services: ServiceContext,
  status = 200,
): Promise<Response> {
  const output = await callTool(tool(name), input, caller, services);
  return ok(output.data ?? {}, status);
}

/** Largest JSON body a route reads: room for a 4 MB file as base64 and the fields around it. */
export const MAX_JSON_BODY_BYTES = 6 * 1024 * 1024;

const tooBig = (cap: number) =>
  new ArtifactError("TOO_LARGE", `The request body is over the ${Math.round(cap / (1024 * 1024))} MB limit.`, {
    limit_bytes: cap,
  });

/** Reads at most `cap` bytes of the request body. A declared length over the cap is refused before reading. */
export async function readBody(request: Request, cap: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > cap) throw tooBig(cap);
  if (!request.body) return new Uint8Array(0);
  return readBounded(request.body, cap, tooBig(cap));
}

/** A JSON object body. An empty body counts as `{}`; anything that is not an object is refused. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const text = new TextDecoder().decode(await readBody(request, MAX_JSON_BODY_BYTES));
  if (!text.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ArtifactError("INVALID_INPUT", "Request body must be valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ArtifactError("INVALID_INPUT", "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

/** Query parameters as an object, with the named ones turned into numbers or booleans. */
export function queryObject(
  url: URL,
  types: { numbers?: string[]; booleans?: string[]; rename?: Record<string, string> } = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of url.searchParams) {
    const key = types.rename?.[rawKey] ?? rawKey;
    if (types.numbers?.includes(key)) out[key] = value.trim() === "" ? Number.NaN : Number(value);
    else if (types.booleans?.includes(key)) out[key] = value === "true" ? true : value === "false" ? false : value;
    else out[key] = value;
  }
  return out;
}
