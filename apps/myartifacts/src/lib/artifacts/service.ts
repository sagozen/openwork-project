import type { Db } from "@templatedesign/platform/db";
import { d1Db } from "@templatedesign/platform/db";
import type { z } from "zod";
import type { Caller } from "../auth/caller";
import { assertScope, SCOPE_READ, SCOPE_WRITE } from "../auth/scopes";
import { newArtifactId, objectKey, sanitizeFilename } from "../storage/keys";
import { DEFAULT_MIME, essence, resolveMime } from "../storage/mime";
import { MAX_PRESIGN_PUT_BYTES, type Storage, StorageError, storageFromEnv } from "../storage/s3";
import type { Env } from "../types";
import { ArtifactError } from "./errors";
import { FetchGuardError, guardedFetch, type HostResolver } from "./fetch-guard";
import {
  artifactId,
  type CreateUploadInput,
  createUploadSchema,
  type DownloadLinkInput,
  downloadLinkSchema,
  type ImportFromUrlInput,
  importFromUrlSchema,
  type ListArtifactsInput,
  listArtifactsSchema,
  type PutBytesInput,
  type PutInlineInput,
  putBytesSchema,
  putInlineSchema,
  type SetExpiryInput,
  setExpirySchema,
} from "./schemas";
import { loadUploadSettings, type UploadSettings } from "./settings";

export interface ArtifactDeps {
  db: Db;
  storage: Storage;
  settings: UploadSettings;
  /** Transport for `import_from_url`. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Host resolver for the import SSRF guard. Defaults to DNS-over-HTTPS. */
  resolveHost?: HostResolver;
  now?: () => Date;
}

/** Dependencies for one request. Settings are read once, so a call sees one snapshot. */
export async function artifactDeps(env: Env): Promise<ArtifactDeps> {
  const db = d1Db(env.DB);
  return { db, storage: storageFromEnv(env), settings: await loadUploadSettings(db) };
}

export interface ArtifactRow {
  id: string;
  tenant_id: string;
  object_key: string;
  name: string;
  mime: string;
  declared_size: number | null;
  size: number | null;
  sha256: string | null;
  status: "pending" | "ready" | "deleted";
  source: "presigned" | "inline" | "url";
  note: string | null;
  expires_at: string | null;
  created_at: string;
  completed_at: string | null;
  deleted_at: string | null;
}

/** What a tool or route returns about a file. The object key and tenant never leave the service. */
export interface ArtifactOut {
  id: string;
  name: string;
  mime: string;
  size: number | null;
  status: ArtifactRow["status"];
  source: ArtifactRow["source"];
  note: string | null;
  sha256: string | null;
  expires_at: string | null;
  created_at: string;
  completed_at: string | null;
}

export function toArtifactOut(row: ArtifactRow): ArtifactOut {
  return {
    id: row.id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    status: row.status,
    source: row.source,
    note: row.note,
    sha256: row.sha256,
    expires_at: row.expires_at,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A presigned upload that was never completed is abandoned after this long, and the hourly cleanup removes it. */
export const PENDING_MAX_AGE_MS = DAY_MS;
/** Files read back as text or as an image block are held in memory, so they are capped. */
export const MAX_READ_TEXT_BYTES = 1024 * 1024;
export const MAX_READ_IMAGE_BYTES = 4 * 1024 * 1024;
/**
 * An import whose source does not say how big it is must be held in memory to learn its length
 * (S3 needs a length up front). Held to a fraction of a Worker's memory, whatever the import cap is.
 */
export const MAX_BUFFERED_IMPORT_BYTES = 32 * 1024 * 1024;

const now = (deps: ArtifactDeps) => (deps.now ?? (() => new Date()))();
const nowIso = (deps: ArtifactDeps) => now(deps).toISOString();
const expiryFrom = (deps: ArtifactDeps, days: number | null | undefined) =>
  days === undefined || days === null ? null : new Date(now(deps).getTime() + days * DAY_MS).toISOString();

/** Parses service input; a failure is a `z.ZodError` the tool and REST layers turn into field errors. */
function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  return schema.parse(input);
}

/** Maps a storage failure to the service's error codes; anything else is returned unchanged. */
function toArtifactError(error: unknown): unknown {
  if (!(error instanceof StorageError)) return error;
  return new ArtifactError(
    "PROVIDER_ERROR",
    error.code === "NOT_FOUND"
      ? "The file is missing from storage."
      : `File storage is unavailable right now. Try again shortly. (${error.message})`,
  );
}

/** Runs a storage call, turning its failures into the service's error codes. */
async function storageCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toArtifactError(error);
  }
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertUploadsEnabled(deps: ArtifactDeps): void {
  if (!deps.settings.enabled) {
    throw new ArtifactError("UPLOADS_DISABLED", "Uploads are switched off for now. Try again later.");
  }
}

/* ------------------------------------------------------------------ lookup */

/**
 * The caller's file, or NOT_FOUND. A file that was deleted, or whose expiry has passed, is treated
 * as gone even before the hourly cleanup removes its object.
 */
async function requireArtifact(
  deps: ArtifactDeps,
  caller: Caller,
  id: string,
  statuses: ArtifactRow["status"][] = ["pending", "ready"],
): Promise<ArtifactRow> {
  const notFound = new ArtifactError("NOT_FOUND", "No file with that id.");
  if (!artifactId.safeParse(id).success) throw notFound;
  const row = await deps.db.first<ArtifactRow>("SELECT * FROM artifacts WHERE id = ? AND tenant_id = ?", [
    id,
    caller.tenantId,
  ]);
  if (!row || !statuses.includes(row.status)) throw notFound;
  if (row.status === "ready" && row.expires_at !== null && row.expires_at <= nowIso(deps)) throw notFound;
  // An abandoned upload can no longer be completed, so the cleanup never races a completion.
  if (row.status === "pending" && Date.parse(row.created_at) + PENDING_MAX_AGE_MS <= now(deps).getTime())
    throw notFound;
  return row;
}

/* ------------------------------------------------------------------ upload */

export interface CreatedUpload {
  artifact_id: string;
  upload_url: string;
  method: "PUT";
  /** Headers to send with the PUT, besides a `Content-Length` of exactly `content_length`. */
  headers: Record<string, string>;
  content_length: number;
  expires_at: string;
}

/**
 * Step one of an upload from a client that can make an HTTP request: records a pending file and
 * returns a presigned PUT pinned to the declared size and type. The bytes never pass through here.
 */
export async function createUpload(
  deps: ArtifactDeps,
  caller: Caller,
  input: CreateUploadInput,
): Promise<CreatedUpload> {
  assertScope(caller, SCOPE_WRITE);
  const parsed = parseInput(createUploadSchema, input);
  assertUploadsEnabled(deps);

  const name = sanitizeFilename(parsed.name);
  const mime = resolveMime(parsed.mime, name);
  const id = newArtifactId();
  const key = objectKey(caller.tenantId, id, name);
  if (parsed.size > MAX_PRESIGN_PUT_BYTES) {
    throw new ArtifactError("TOO_LARGE", "A single upload can be at most 5 GB.");
  }
  const presigned = await storageCall(() =>
    deps.storage.presignPut(key, { contentType: mime, contentLength: parsed.size }),
  );
  await deps.db.run(
    `INSERT INTO artifacts (id, tenant_id, object_key, name, mime, declared_size, size, status, source, note, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', 'presigned', ?, ?, ?)`,
    [
      id,
      caller.tenantId,
      key,
      name,
      mime,
      parsed.size,
      parsed.note ?? null,
      expiryFrom(deps, parsed.expires_in_days),
      nowIso(deps),
    ],
  );
  return {
    artifact_id: id,
    upload_url: presigned.url,
    method: "PUT",
    headers: presigned.headers,
    content_length: parsed.size,
    expires_at: presigned.expiresAt,
  };
}

/**
 * Step two: confirms the bytes arrived. The object's real size, read from storage, is what gets
 * recorded; an object of a different size than declared is deleted and the upload refused.
 * Completing an already completed upload returns it unchanged.
 */
export async function completeUpload(deps: ArtifactDeps, caller: Caller, id: string): Promise<ArtifactOut> {
  assertScope(caller, SCOPE_WRITE);
  const row = await requireArtifact(deps, caller, id);
  if (row.status === "ready") return toArtifactOut(row);

  let head: Awaited<ReturnType<Storage["headObject"]>>;
  try {
    head = await deps.storage.headObject(row.object_key);
  } catch (error) {
    if (error instanceof StorageError && error.code === "NOT_FOUND") {
      throw new ArtifactError(
        "UPLOAD_NOT_FOUND",
        "Nothing has been uploaded to this upload URL yet. PUT the file to it first, then call this again.",
      );
    }
    throw toArtifactError(error);
  }
  if (head.size !== row.declared_size) {
    await storageCall(() => deps.storage.deleteObject(row.object_key));
    await deps.db.run(
      "UPDATE artifacts SET status = 'deleted', deleted_at = ? WHERE id = ? AND tenant_id = ? AND status = 'pending'",
      [nowIso(deps), row.id, caller.tenantId],
    );
    throw new ArtifactError(
      "INVALID_INPUT",
      "The uploaded file is not the size that was declared, so it was discarded. Create a new upload and send exactly the declared bytes.",
      { declared_size: row.declared_size, uploaded_size: head.size },
    );
  }
  const completedAt = nowIso(deps);
  await deps.db.run(
    "UPDATE artifacts SET status = 'ready', size = ?, completed_at = ? WHERE id = ? AND tenant_id = ? AND status = 'pending'",
    [head.size, completedAt, row.id, caller.tenantId],
  );
  return toArtifactOut(await requireArtifact(deps, caller, id, ["ready"]));
}

/** Inserts the row of a file whose object is already stored; removes the object again if that fails. */
async function recordReady(
  deps: ArtifactDeps,
  caller: Caller,
  file: {
    id: string;
    key: string;
    name: string;
    mime: string;
    size: number;
    sha256: string | null;
    source: ArtifactRow["source"];
    note: string | null | undefined;
    expiresInDays: number | undefined;
  },
): Promise<ArtifactOut> {
  const created = nowIso(deps);
  try {
    await deps.db.run(
      `INSERT INTO artifacts (id, tenant_id, object_key, name, mime, declared_size, size, sha256, status, source, note, expires_at, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?)`,
      [
        file.id,
        caller.tenantId,
        file.key,
        file.name,
        file.mime,
        file.size,
        file.size,
        file.sha256,
        file.source,
        file.note ?? null,
        expiryFrom(deps, file.expiresInDays),
        created,
        created,
      ],
    );
  } catch (error) {
    await deps.storage.deleteObject(file.key).catch(() => undefined);
    throw error;
  }
  return toArtifactOut(await requireArtifact(deps, caller, file.id, ["ready"]));
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decodes base64 strictly and checks the decoded size against `cap` before allocating anything. */
function decodeBase64(content: string, cap: number): Uint8Array<ArrayBuffer> {
  const text = content.replace(/\s+/g, "");
  if (!BASE64.test(text) || text.length % 4 === 1) {
    throw new ArtifactError("INVALID_INPUT", "content is not valid base64.");
  }
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const decoded = Math.floor((text.length * 3) / 4) - padding;
  if (decoded > cap) throw tooLarge("The content", cap, "inline");
  try {
    const binary = atob(text);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw new ArtifactError("INVALID_INPUT", "content is not valid base64.");
  }
}

function tooLarge(what: string, cap: number, via: "inline" | "import"): ArtifactError {
  const mb = Math.round((cap / (1024 * 1024)) * 10) / 10;
  return new ArtifactError(
    "TOO_LARGE",
    via === "inline"
      ? `${what} is over the ${mb} MB limit for inline uploads. Use create_upload and PUT the file to the returned URL instead.`
      : `${what} is over the ${mb} MB limit for imports.`,
    { limit_bytes: cap },
  );
}

/** Stores a small file whose content arrives in the request. The only path that works from chat-only clients. */
export async function putInline(deps: ArtifactDeps, caller: Caller, input: PutInlineInput): Promise<ArtifactOut> {
  assertScope(caller, SCOPE_WRITE);
  const parsed = parseInput(putInlineSchema, input);
  assertUploadsEnabled(deps);
  const cap = deps.settings.maxInlineBytes;

  let bytes: Uint8Array<ArrayBuffer>;
  if (parsed.encoding === "base64") {
    bytes = decodeBase64(parsed.content, cap);
  } else {
    // Every UTF-16 unit takes at least one byte, so a longer string cannot fit.
    if (parsed.content.length > cap) throw tooLarge("The content", cap, "inline");
    bytes = new TextEncoder().encode(parsed.content);
    if (bytes.length > cap) throw tooLarge("The content", cap, "inline");
  }

  return storeInline(deps, caller, parsed, bytes, parsed.encoding === "text");
}

/**
 * Stores raw bytes that arrived as a request body (the REST upload of a small binary). Subject to
 * the same inline cap as `putInline`.
 */
export async function putBytes(
  deps: ArtifactDeps,
  caller: Caller,
  input: PutBytesInput,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<ArtifactOut> {
  assertScope(caller, SCOPE_WRITE);
  const parsed = parseInput(putBytesSchema, input);
  assertUploadsEnabled(deps);
  if (bytes.length > deps.settings.maxInlineBytes) throw tooLarge("The file", deps.settings.maxInlineBytes, "inline");
  return storeInline(deps, caller, parsed, bytes, false);
}

async function storeInline(
  deps: ArtifactDeps,
  caller: Caller,
  meta: { name: string; mime?: string; note?: string | null; expires_in_days?: number },
  bytes: Uint8Array<ArrayBuffer>,
  isText: boolean,
): Promise<ArtifactOut> {
  const name = sanitizeFilename(meta.name);
  // Text with no type and no known extension is plain text; anything else is typed by what it is called.
  const resolved = resolveMime(meta.mime, name);
  const mime = resolved === DEFAULT_MIME && isText ? "text/plain" : resolved;
  const id = newArtifactId();
  const key = objectKey(caller.tenantId, id, name);
  const sha256 = await sha256Hex(bytes);
  await storageCall(() => deps.storage.putObject(key, bytes, { contentType: mime }));
  return recordReady(deps, caller, {
    id,
    key,
    name,
    mime,
    size: bytes.length,
    sha256,
    source: "inline",
    note: meta.note,
    expiresInDays: meta.expires_in_days,
  });
}

/** Passes a stream through while counting it; errors the stream when it goes over `cap` or misses `exact`. */
function countingStream(
  source: ReadableStream<Uint8Array>,
  cap: number,
  exact: number,
  fail: (error: ArtifactError) => void,
): ReadableStream<Uint8Array> {
  let seen = 0;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > cap || seen > exact) {
          const error =
            seen > cap
              ? tooLarge("The file", cap, "import")
              : new ArtifactError("INVALID_INPUT", "The source sent more bytes than it said it would.");
          fail(error);
          controller.error(error);
          return;
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (seen !== exact) {
          const error = new ArtifactError("INVALID_INPUT", "The source sent fewer bytes than it said it would.");
          fail(error);
          controller.error(error);
        }
      },
    }),
  );
}

/** Reads a stream whose length is unknown into memory, giving up as soon as it passes `cap`. */
export async function readBounded(
  body: ReadableStream<Uint8Array>,
  cap: number,
  limit: ArtifactError,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => undefined);
        throw limit;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function nameFromUrl(url: URL): string {
  const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
  try {
    return decodeURIComponent(last) || "download";
  } catch {
    return last || "download";
  }
}

/**
 * Makes the Worker fetch a public https URL and store it. The URL goes through the SSRF guard on
 * every hop; the body is counted while it streams and aborted past the import cap.
 */
export async function importFromUrl(
  deps: ArtifactDeps,
  caller: Caller,
  input: ImportFromUrlInput,
): Promise<ArtifactOut> {
  assertScope(caller, SCOPE_WRITE);
  const parsed = parseInput(importFromUrlSchema, input);
  assertUploadsEnabled(deps);
  const cap = deps.settings.maxImportBytes;

  let fetched: Awaited<ReturnType<typeof guardedFetch>>;
  try {
    fetched = await guardedFetch(parsed.url, { fetch: deps.fetch, resolve: deps.resolveHost });
  } catch (error) {
    if (error instanceof FetchGuardError) throw new ArtifactError("INVALID_INPUT", error.message);
    throw error;
  }
  const { response, url } = fetched;
  const discard = () => response.body?.cancel().catch(() => undefined);
  if (!response.ok || !response.body) {
    await discard();
    throw new ArtifactError("INVALID_INPUT", `The source answered HTTP ${response.status}, so nothing was imported.`);
  }

  // A compressed response reports the compressed length, which is not the number of bytes we will read.
  const encoded = (response.headers.get("content-encoding") ?? "identity").toLowerCase() !== "identity";
  const header = encoded ? null : response.headers.get("content-length");
  const declared = header !== null && /^\d+$/.test(header) ? Number(header) : null;
  if (declared !== null && declared > cap) {
    await discard();
    throw tooLarge("The file", cap, "import");
  }

  const name = sanitizeFilename(parsed.name ?? nameFromUrl(url));
  const mime = resolveMime(parsed.mime ?? essence(response.headers.get("content-type")), name);
  const id = newArtifactId();
  const key = objectKey(caller.tenantId, id, name);

  let aborted: ArtifactError | null = null;
  let size: number;
  try {
    if (declared !== null) {
      size = declared;
      const body = countingStream(response.body, cap, declared, (error) => {
        aborted = error;
      });
      await storageCall(() => deps.storage.putObject(key, body, { contentType: mime, contentLength: declared }));
    } else {
      const bufferCap = Math.min(cap, MAX_BUFFERED_IMPORT_BYTES);
      const limit =
        bufferCap < cap
          ? new ArtifactError(
              "TOO_LARGE",
              `The source does not say how big the file is, so only files up to ${Math.round(bufferCap / (1024 * 1024))} MB can be imported from it.`,
              { limit_bytes: bufferCap },
            )
          : tooLarge("The file", cap, "import");
      const bytes = await readBounded(response.body, bufferCap, limit);
      size = bytes.length;
      await storageCall(() => deps.storage.putObject(key, bytes, { contentType: mime }));
    }
  } catch (error) {
    // A stream the counter stopped surfaces from storage as a provider error; report the real reason.
    await deps.storage.deleteObject(key).catch(() => undefined);
    throw aborted ?? error;
  }
  return recordReady(deps, caller, {
    id,
    key,
    name,
    mime,
    size,
    sha256: null,
    source: "url",
    note: parsed.note,
    expiresInDays: parsed.expires_in_days,
  });
}

/* ------------------------------------------------------------------- reads */

export interface ArtifactPage {
  items: ArtifactOut[];
  next_cursor: string | null;
}

function encodeCursor(row: Pick<ArtifactRow, "created_at" | "id">): string {
  return btoa(`${row.created_at}|${row.id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const text = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const [createdAt, id] = text.split("|");
    if (createdAt && id && artifactId.safeParse(id).success && !Number.isNaN(Date.parse(createdAt))) {
      return { createdAt, id };
    }
  } catch {
    // Falls through to the error below.
  }
  throw new ArtifactError("INVALID_INPUT", "That cursor is not valid. Start again without one.");
}

/** The caller's files, newest first, a page at a time. Expired files are left out. */
export async function listArtifacts(
  deps: ArtifactDeps,
  caller: Caller,
  input: ListArtifactsInput = {},
): Promise<ArtifactPage> {
  assertScope(caller, SCOPE_READ);
  const parsed = parseInput(listArtifactsSchema, input);
  const clauses = ["status = ?"];
  const params: unknown[] = [caller.tenantId, parsed.status];
  if (parsed.status === "ready") {
    clauses.push("(expires_at IS NULL OR expires_at > ?)");
    params.push(nowIso(deps));
  }
  if (parsed.query) {
    clauses.push("name LIKE ? ESCAPE '\\'");
    params.push(`%${parsed.query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
  }
  if (parsed.cursor) {
    const { createdAt, id } = decodeCursor(parsed.cursor);
    clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
    params.push(createdAt, createdAt, id);
  }
  const rows = await deps.db.all<ArtifactRow>(
    `SELECT * FROM artifacts WHERE tenant_id = ? AND ${clauses.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
    [...params, parsed.limit + 1],
  );
  const page = rows.slice(0, parsed.limit);
  return {
    items: page.map(toArtifactOut),
    next_cursor: rows.length > parsed.limit ? encodeCursor(page[page.length - 1]) : null,
  };
}

export async function getArtifact(deps: ArtifactDeps, caller: Caller, id: string): Promise<ArtifactOut> {
  assertScope(caller, SCOPE_READ);
  return toArtifactOut(await requireArtifact(deps, caller, id));
}

/** Total bytes and number of the caller's ready files. */
export async function usage(deps: ArtifactDeps, caller: Caller): Promise<{ files: number; bytes: number }> {
  assertScope(caller, SCOPE_READ);
  const row = await deps.db.first<{ files: number; bytes: number }>(
    "SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM artifacts WHERE tenant_id = ? AND status = 'ready' AND (expires_at IS NULL OR expires_at > ?)",
    [caller.tenantId, nowIso(deps)],
  );
  return { files: row?.files ?? 0, bytes: row?.bytes ?? 0 };
}

export interface DownloadLink {
  url: string;
  expires_at: string;
  /** What the link will do. Types a browser could run are always `attachment`, whatever was asked. */
  disposition: "inline" | "attachment";
  name: string;
  mime: string;
  size: number | null;
}

/** A presigned GET for a ready file: 1 minute to 7 days, 1 hour by default. */
export async function downloadLink(
  deps: ArtifactDeps,
  caller: Caller,
  id: string,
  input: DownloadLinkInput = {},
): Promise<DownloadLink> {
  assertScope(caller, SCOPE_READ);
  const parsed = parseInput(downloadLinkSchema, input);
  const row = await requireArtifact(deps, caller, id, ["ready"]);
  const link = await storageCall(() =>
    deps.storage.presignGet(row.object_key, {
      filename: row.name,
      contentType: row.mime,
      disposition: parsed.disposition,
      ttl: parsed.ttl_seconds,
    }),
  );
  return {
    url: link.url,
    expires_at: link.expiresAt,
    disposition: link.disposition,
    name: row.name,
    mime: row.mime,
    size: row.size,
  };
}

export type FileContent =
  | { kind: "text"; text: string; name: string; mime: string; size: number }
  | { kind: "image"; data: string; name: string; mime: string; size: number };

const READABLE_IMAGES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function isTextMime(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/yaml" ||
    mime === "application/x-yaml" ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/**
 * The content of a small file, for a model to read: text up to 1 MB, or an image up to 4 MB as
 * base64. Anything else, or anything larger, is refused with a pointer to `get_download_link`.
 */
export async function readContent(deps: ArtifactDeps, caller: Caller, id: string): Promise<FileContent> {
  assertScope(caller, SCOPE_READ);
  const row = await requireArtifact(deps, caller, id, ["ready"]);
  const size = row.size ?? 0;
  const mime = essence(row.mime) ?? "application/octet-stream";
  const kind = isTextMime(mime) ? "text" : READABLE_IMAGES.has(mime) ? "image" : null;
  if (!kind) {
    throw new ArtifactError(
      "INVALID_INPUT",
      `A ${mime} file cannot be read as text or as an image. Use get_download_link to give the user a link instead.`,
    );
  }
  const limit = kind === "text" ? MAX_READ_TEXT_BYTES : MAX_READ_IMAGE_BYTES;
  if (size > limit) {
    throw new ArtifactError(
      "TOO_LARGE",
      `This file is ${size} bytes; ${kind === "text" ? "text" : "images"} can be read up to ${limit} bytes. Use get_download_link instead.`,
      { size, limit_bytes: limit },
    );
  }
  const object = await storageCall(() => deps.storage.getObject(row.object_key));
  // The row's size is a promise; the read is bounded by the limit whatever the object turns out to be.
  const bytes = await readBounded(
    object.body,
    limit,
    new ArtifactError("TOO_LARGE", "The stored file is larger than recorded; refusing to read it.", {
      limit_bytes: limit,
    }),
  );
  return kind === "text"
    ? { kind, text: new TextDecoder().decode(bytes), name: row.name, mime, size: bytes.length }
    : { kind, data: toBase64(bytes), name: row.name, mime, size: bytes.length };
}

/* --------------------------------------------------------------- mutations */

/** Sets the day a file is removed, or clears it (null) to keep the file until it is deleted. */
export async function setExpiry(
  deps: ArtifactDeps,
  caller: Caller,
  id: string,
  input: SetExpiryInput,
): Promise<ArtifactOut> {
  assertScope(caller, SCOPE_WRITE);
  const parsed = parseInput(setExpirySchema, input);
  const row = await requireArtifact(deps, caller, id);
  await deps.db.run(
    "UPDATE artifacts SET expires_at = ? WHERE id = ? AND tenant_id = ? AND status IN ('pending', 'ready')",
    [expiryFrom(deps, parsed.expires_in_days), row.id, caller.tenantId],
  );
  return toArtifactOut(await requireArtifact(deps, caller, id));
}

/**
 * Removes a file: the object first, then the row is marked deleted and the file leaves every share
 * bundle. A file that is already deleted is not an error, so the call can be repeated. If storage
 * fails nothing is changed and the call can be retried.
 */
export async function deleteArtifact(
  deps: ArtifactDeps,
  caller: Caller,
  id: string,
): Promise<{ id: string; deleted: true }> {
  assertScope(caller, SCOPE_WRITE);
  const row = await requireArtifact(deps, caller, id, ["pending", "ready", "deleted"]);
  if (row.status !== "deleted") {
    await storageCall(() => deps.storage.deleteObject(row.object_key));
    await deps.db.batch([
      {
        sql: "UPDATE artifacts SET status = 'deleted', deleted_at = ? WHERE id = ? AND tenant_id = ?",
        params: [nowIso(deps), row.id, caller.tenantId],
      },
      { sql: "DELETE FROM share_items WHERE artifact_id = ? AND tenant_id = ?", params: [row.id, caller.tenantId] },
    ]);
  }
  return { id: row.id, deleted: true };
}
