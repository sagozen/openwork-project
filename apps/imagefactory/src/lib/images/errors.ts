/** Stable error codes shared by the MCP tools and the REST API. */
export type ImageErrorCode =
  | "INSUFFICIENT_CREDITS"
  | "INSUFFICIENT_SCOPE"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "PROVIDER_ERROR"
  | "CONTENT_BLOCKED"
  | "JOB_PENDING";

export class ImageError extends Error {
  constructor(
    public readonly code: ImageErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
