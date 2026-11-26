import type { FieldError, ProblemDetails } from "./types";

const DEFAULT_ERROR_MESSAGE = "Không thể hoàn tất thao tác.";

export class ApiError extends Error {
  readonly status: number;
  readonly body: ProblemDetails;
  readonly code?: string;
  readonly traceId?: string;
  readonly timestamp?: string;
  readonly fieldErrors?: FieldError[];

  constructor(status: number, body: ProblemDetails = {}, options?: ErrorOptions) {
    super(body.message ?? DEFAULT_ERROR_MESSAGE, options);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.code = body.code;
    this.traceId = body.traceId;
    this.timestamp = body.timestamp;
    this.fieldErrors = body.fieldErrors;
  }
}

export function apiErrorMessage(error: unknown, fallback = DEFAULT_ERROR_MESSAGE): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : fallback;
  const fieldMessages = error.fieldErrors?.map(({ message }) => message).filter(Boolean) ?? [];
  const message = fieldMessages.length > 0 ? fieldMessages.join(" ") : error.message;
  return error.traceId ? `${message} · Trace ID: ${error.traceId}` : message;
}

export function apiFieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || !error.fieldErrors) return {};
  return Object.fromEntries(error.fieldErrors.map(({ field, message }) => [field, message]));
}
