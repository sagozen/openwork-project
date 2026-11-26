import { AwsClient, AwsV4Signer } from "aws4fetch";
import type { Env } from "../types";
import { contentDisposition, encodeRfc3986 } from "./keys";
import { essence, isInlineSafe } from "./mime";

/**
 * S3-compatible object storage (Contabo) over SigV4, path-style (`<endpoint>/<bucket>/<key>`).
 *
 * Bytes do not pass through the Worker on the normal path: callers hand out presigned PUT and GET
 * URLs and only use `putObject` and `getObject` for small inline files and imports. There are no
 * automatic retries; a failed call surfaces as a `StorageError` and the caller decides.
 */

export type StorageErrorCode = "NOT_FOUND" | "PROVIDER_ERROR";

/** A storage failure. The message never carries the provider's response body or any credential. */
export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

/** SigV4 caps a presigned URL at 7 days. */
export const MAX_PRESIGN_GET_SECONDS = 7 * 24 * 60 * 60;
export const MIN_PRESIGN_GET_SECONDS = 60;
export const DEFAULT_PRESIGN_GET_SECONDS = 60 * 60;
/** A presigned PUT is valid for 15 minutes, fixed. */
export const PRESIGN_PUT_SECONDS = 15 * 60;
/** Largest object one presigned PUT can carry (S3's single-PUT limit). */
export const MAX_PRESIGN_PUT_BYTES = 5 * 1024 ** 3;
const MAX_KEY_BYTES = 1024;

const CONTROL_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 120_000;

export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Transport for signed requests. Defaults to the global `fetch`; tests pass a fake. */
  fetch?: (request: Request) => Promise<Response>;
  /** Clock used to date signatures and compute expiry. Defaults to the current time. */
  now?: () => Date;
  /**
   * Constructor of a pass-through stream that carries exactly `length` bytes. The Workers runtime
   * sends a stream body with that length instead of chunked transfer encoding, which S3 refuses.
   * Defaults to the runtime's global `FixedLengthStream`; where there is none (Node) the stream is
   * sent as is with an explicit `Content-Length` header.
   */
  fixedLengthStream?: FixedLengthStreamConstructor;
}

export interface FixedLengthStreamConstructor {
  new (length: number): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
}

export interface ObjectHead {
  /** Real size in bytes, as the store reports it. */
  size: number;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
}

export type PutBody = string | Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>;

export interface PresignedRequest {
  url: string;
  method: "GET" | "PUT";
  /** Headers the client must send unchanged. For a PUT it must also send `Content-Length` with the signed size. */
  headers: Record<string, string>;
  expiresAt: string;
}

export interface PresignedDownload extends PresignedRequest {
  /** What the URL will actually do: unsafe types are always `attachment`, whatever was asked for. */
  disposition: "inline" | "attachment";
}

export interface Storage {
  headObject(key: string): Promise<ObjectHead>;
  putObject(key: string, body: PutBody, options: { contentType: string; contentLength?: number }): Promise<void>;
  getObject(
    key: string,
    options?: { range?: { start: number; end: number } },
  ): Promise<{ body: ReadableStream<Uint8Array>; contentType: string | null; contentLength: number | null }>;
  /** Deletes the object. A missing object is not an error, so cleanup can be rerun. */
  deleteObject(key: string): Promise<void>;
  presignPut(key: string, options: { contentType: string; contentLength: number }): Promise<PresignedRequest>;
  presignGet(
    key: string,
    options: { filename: string; contentType: string; disposition?: "inline" | "attachment"; ttl?: number },
  ): Promise<PresignedDownload>;
}

/** The storage client for a Worker request. Throws a `StorageError` when the object store is not configured. */
export function storageFromEnv(
  env: Pick<Env, "S3_ENDPOINT" | "S3_REGION" | "S3_BUCKET" | "S3_ACCESS_KEY_ID" | "S3_SECRET_ACCESS_KEY">,
): Storage {
  const missing = (
    [
      ["S3_ENDPOINT", env.S3_ENDPOINT],
      ["S3_REGION", env.S3_REGION],
      ["S3_BUCKET", env.S3_BUCKET],
      ["S3_ACCESS_KEY_ID", env.S3_ACCESS_KEY_ID],
      ["S3_SECRET_ACCESS_KEY", env.S3_SECRET_ACCESS_KEY],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new StorageError("PROVIDER_ERROR", `Object storage is not configured: ${missing.join(", ")} missing.`);
  }
  return createStorage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  });
}

/** `YYYYMMDDTHHMMSSZ`, the timestamp format SigV4 signs. */
function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function clampTtl(ttl: number | undefined): number {
  if (ttl === undefined || !Number.isFinite(ttl)) return DEFAULT_PRESIGN_GET_SECONDS;
  return Math.min(MAX_PRESIGN_GET_SECONDS, Math.max(MIN_PRESIGN_GET_SECONDS, Math.floor(ttl)));
}

function assertKey(key: string): void {
  if (
    key === "" ||
    key.startsWith("/") ||
    key.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is being rejected
    /[\u0000-\u001f\u007f]/.test(key) ||
    new TextEncoder().encode(key).length > MAX_KEY_BYTES
  ) {
    throw new StorageError("PROVIDER_ERROR", "Invalid object key.");
  }
}

function isStream(body: PutBody): body is ReadableStream<Uint8Array> {
  return typeof body === "object" && "getReader" in body;
}

/** Length of a body that carries its own; undefined for a stream, whose caller must say. */
function bodyLength(body: PutBody): number | undefined {
  if (typeof body === "string") return new TextEncoder().encode(body).length;
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) return body.byteLength;
  return undefined;
}

/** A header-safe content type, or a `StorageError` when the value cannot be one. */
function requireContentType(value: string): string {
  const type = essence(value);
  if (!type) throw new StorageError("PROVIDER_ERROR", "Invalid content type.");
  return type;
}

export function createStorage(config: StorageConfig): Storage {
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    throw new StorageError("PROVIDER_ERROR", "Object storage endpoint is not a valid URL.");
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new StorageError("PROVIDER_ERROR", "Object storage endpoint must be an http(s) URL.");
  }
  const base = `${endpoint.origin}/${encodeRfc3986(config.bucket)}`;
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: config.region,
  });
  const FixedLength =
    config.fixedLengthStream ?? (globalThis as { FixedLengthStream?: FixedLengthStreamConstructor }).FixedLengthStream;

  /** Routes a stream through a fixed-length stream when the runtime has one, so the length is honoured. */
  function fixedLength(body: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
    if (!FixedLength) return body;
    const fixed = new FixedLength(length);
    // A source that errors or sends the wrong number of bytes fails the upload through `readable`.
    body.pipeTo(fixed.writable).catch(() => undefined);
    return fixed.readable;
  }

  const transport = config.fetch ?? ((request: Request) => fetch(request));
  const now = config.now ?? (() => new Date());

  const objectUrl = (key: string): URL => {
    assertKey(key);
    return new URL(`${base}/${key.split("/").map(encodeRfc3986).join("/")}`);
  };

  /** Signs and sends one request. Non-2xx answers and network failures become `StorageError`s. */
  async function send(
    op: string,
    method: "GET" | "HEAD" | "PUT" | "DELETE",
    key: string,
    init: { headers?: Record<string, string>; body?: PutBody; timeoutMs: number; allow?: number[] },
  ): Promise<Response> {
    const signed = await client.sign(objectUrl(key), {
      method,
      headers: { "x-amz-content-sha256": "UNSIGNED-PAYLOAD", ...init.headers },
      body: init.body as BodyInit | undefined,
      signal: AbortSignal.timeout(init.timeoutMs),
      aws: { datetime: amzDate(now()) },
    });
    let response: Response;
    try {
      response = await transport(signed);
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new StorageError(
        "PROVIDER_ERROR",
        `Object storage ${op} ${timedOut ? "timed out" : "could not be reached"}.`,
      );
    }
    if (response.ok || init.allow?.includes(response.status)) return response;
    // Free the connection without reading (and so never surfacing) the provider's error body.
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 404) throw new StorageError("NOT_FOUND", "Object not found.", 404);
    throw new StorageError("PROVIDER_ERROR", `Object storage ${op} failed (HTTP ${response.status}).`, response.status);
  }

  /** A query-signed URL. Signing the headers of a PUT is what pins it to its declared type and size. */
  async function presign(
    method: "GET" | "PUT",
    key: string,
    ttl: number,
    query: Record<string, string>,
    headers: Record<string, string>,
  ): Promise<PresignedRequest> {
    const url = objectUrl(key);
    url.searchParams.set("X-Amz-Expires", String(ttl));
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const issued = now();
    const signed = await new AwsV4Signer({
      url: url.toString(),
      method,
      headers,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: "s3",
      region: config.region,
      signQuery: true,
      allHeaders: Object.keys(headers).length > 0,
      datetime: amzDate(issued),
    }).sign();
    return {
      url: signed.url.toString(),
      method,
      headers: Object.fromEntries(Object.entries(headers).filter(([name]) => name !== "content-length")),
      expiresAt: new Date(issued.getTime() + ttl * 1000).toISOString(),
    };
  }

  return {
    async headObject(key) {
      const response = await send("HEAD", "HEAD", key, { timeoutMs: CONTROL_TIMEOUT_MS });
      const length = response.headers.get("content-length");
      const size = length === null || length.trim() === "" ? Number.NaN : Number(length);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new StorageError("PROVIDER_ERROR", "Object storage HEAD returned no usable size.");
      }
      return {
        size,
        contentType: response.headers.get("content-type"),
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
      };
    },

    async putObject(key, body, options) {
      const contentType = requireContentType(options.contentType);
      const length = options.contentLength ?? bodyLength(body);
      if (length === undefined || !Number.isSafeInteger(length) || length < 0) {
        throw new StorageError("PROVIDER_ERROR", "A stream upload needs its content length.");
      }
      const response = await send("PUT", "PUT", key, {
        headers: { "content-type": contentType, "content-length": String(length) },
        body: isStream(body) ? fixedLength(body, length) : body,
        timeoutMs: WRITE_TIMEOUT_MS,
      });
      await response.body?.cancel().catch(() => undefined);
    },

    async getObject(key, options) {
      const range = options?.range;
      const response = await send("GET", "GET", key, {
        headers: range ? { range: `bytes=${range.start}-${range.end}` } : undefined,
        timeoutMs: READ_TIMEOUT_MS,
      });
      if (!response.body) throw new StorageError("PROVIDER_ERROR", "Object storage GET returned no body.");
      const length = response.headers.get("content-length");
      return {
        body: response.body,
        contentType: response.headers.get("content-type"),
        contentLength: length === null ? null : Number(length),
      };
    },

    async deleteObject(key) {
      try {
        const response = await send("DELETE", "DELETE", key, { timeoutMs: CONTROL_TIMEOUT_MS });
        await response.body?.cancel().catch(() => undefined);
      } catch (error) {
        if (error instanceof StorageError && error.code === "NOT_FOUND") return;
        throw error;
      }
    },

    async presignPut(key, options) {
      const contentType = requireContentType(options.contentType);
      const { contentLength } = options;
      if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > MAX_PRESIGN_PUT_BYTES) {
        throw new StorageError("PROVIDER_ERROR", "Upload size must be between 0 bytes and 5 GB.");
      }
      return presign(
        "PUT",
        key,
        PRESIGN_PUT_SECONDS,
        {},
        {
          "content-type": contentType,
          "content-length": String(contentLength),
        },
      );
    },

    async presignGet(key, options) {
      const contentType = essence(options.contentType) ?? "application/octet-stream";
      const requested = options.disposition ?? "attachment";
      const disposition = requested === "inline" && isInlineSafe(contentType) ? "inline" : "attachment";
      const result = await presign(
        "GET",
        key,
        clampTtl(options.ttl),
        {
          "response-content-type": contentType,
          "response-content-disposition": contentDisposition(disposition, options.filename),
        },
        {},
      );
      return { ...result, disposition };
    },
  };
}
