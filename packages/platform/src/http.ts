import { type ErrorCode, problem } from "@templatedesign/contracts";
import { LOCALE_COOKIE, parseCookies } from "./csrf";
import type { Locale } from "./types";

export class HttpError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    message?: string,
    public readonly details?: Record<string, unknown>,
    public readonly headers?: HeadersInit,
  ) {
    super(message ?? code);
  }
}

export function localeFor(request: Request): Locale {
  const cookies = parseCookies(request.headers.get("cookie"));
  return cookies[LOCALE_COOKIE] === "vi" ? "vi" : "en";
}

export function errorResponse(error: unknown, request: Request): Response {
  if (error instanceof HttpError) {
    const body = problem(error.code, {
      locale: localeFor(request),
      detail: error.message,
      details: error.details,
    });
    return new Response(JSON.stringify(body), {
      status: error.status,
      headers: { "content-type": "application/problem+json; charset=utf-8", ...headersObject(error.headers) },
    });
  }
  console.error("Unhandled API error", error instanceof Error ? error.message : "unknown");
  const body = problem("dependency_unavailable", { locale: localeFor(request) });
  return new Response(JSON.stringify(body), {
    status: 503,
    headers: { "content-type": "application/problem+json; charset=utf-8" },
  });
}

function headersObject(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers;
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...headersObject(init.headers) },
  });
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError("invalid_input", 400, "Request body must be valid JSON.");
  }
}

export function requireUser<T>(value: T | null | undefined): T {
  if (!value) throw new HttpError("unauthenticated", 401);
  return value;
}

export async function handleApi(request: Request, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    return errorResponse(error, request);
  }
}
