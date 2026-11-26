/** Stable error codes shared by the MCP tools and the REST API. */
export type ArtifactErrorCode =
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "UPLOAD_NOT_FOUND"
  | "TOO_LARGE"
  | "UPLOADS_DISABLED"
  | "PROVIDER_ERROR"
  | "INSUFFICIENT_SCOPE"
  | "VALIDATION_ERROR"
  | "INTERNAL_ERROR";

export class ArtifactError extends Error {
  constructor(
    public readonly code: ArtifactErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ArtifactError";
  }
}
