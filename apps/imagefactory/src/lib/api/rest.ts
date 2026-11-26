import { HttpError } from "@templatedesign/platform/http";
import { z } from "zod";
import { withCaller } from "../auth/caller";
import { ImageError, type ImageErrorCode } from "../images/errors";
import type { Caller, ServiceDeps } from "../images/service";
import { serviceFor } from "../mcp/context";

const STATUS: Record<ImageErrorCode, number> = {
  INSUFFICIENT_CREDITS: 402,
  INSUFFICIENT_SCOPE: 403,
  INVALID_INPUT: 422,
  NOT_FOUND: 404,
  PROVIDER_ERROR: 502,
  CONTENT_BLOCKED: 422,
  JOB_PENDING: 202,
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function body(code: string, message: string, details?: unknown): string {
  return JSON.stringify({ error: { code, message, ...(details ? { details } : {}) } });
}

/** The same stable codes the MCP tools return, as HTTP statuses. */
export function restError(error: unknown): Response {
  if (error instanceof ImageError) {
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
    const code = error.code === "insufficient_credits" ? "INSUFFICIENT_CREDITS" : error.code.toUpperCase();
    return new Response(body(code, error.message, error.details), { status: error.status, headers: JSON_HEADERS });
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

/** Parses a JSON body with a strict schema. An empty body counts as `{}`. */
export async function readBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  const text = await request.text();
  let value: unknown = {};
  if (text.trim()) {
    try {
      value = JSON.parse(text);
    } catch {
      throw new ImageError("INVALID_INPUT", "Request body must be valid JSON.");
    }
  }
  return schema.parse(value);
}

/**
 * Runs a REST handler for an authenticated caller. Authentication is the same function the MCP
 * endpoint uses, so an API key behaves identically on both.
 */
export async function rest(
  request: Request,
  handler: (caller: Caller, deps: ServiceDeps) => Promise<Response>,
): Promise<Response> {
  // Loaded on demand: the Workers runtime module does not exist under the Node test runner.
  const { runtimeEnv } = await import("../runtime");
  return withCaller(runtimeEnv(), request, async (caller) => {
    try {
      return await handler(caller, await serviceFor());
    } catch (error) {
      return restError(error);
    }
  });
}

/** `?wait=false` returns 202 with a job id instead of waiting up to 45 seconds. */
export function wantsWait(url: URL): boolean {
  return url.searchParams.get("wait") !== "false";
}
