import type { Db } from "@templatedesign/platform/db";
import { id, nowIso } from "@templatedesign/platform/db";
import { HttpError } from "@templatedesign/platform/http";
import { uploadLimitMb } from "./pricing";
import { mediaKey, presignConfigured, presignR2 } from "./r2-presign";
import type { Env } from "./types";

const AUDIO = [
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/webm",
  "audio/flac",
  "audio/aac",
];
const VIDEO = ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska", "video/mpeg", "video/3gpp"];

export function isAllowedMediaType(contentType: string): boolean {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return AUDIO.includes(type) || VIDEO.includes(type) || type.startsWith("audio/") || type.startsWith("video/");
}

export interface UploadRow {
  id: string;
  tenant_id: string | null;
  guest_id: string | null;
  r2_key: string;
  upload_id: string | null;
  filename: string | null;
  content_type: string | null;
  size_bytes: number | null;
  status: "pending" | "completed" | "aborted";
  created_at: string;
  completed_at: string | null;
  expires_at: string;
}

export interface UploadSession {
  id: string;
  key: string;
  url: string;
  expiresInSeconds: number;
  filename: string;
  contentType: string;
  sizeBytes: number;
  maxBytes: number;
}

/**
 * One presigned PUT straight to R2 (bytes never touch the Worker). Multipart uploads add
 * resumability but no product value at this size, so the MVP signs a single request and
 * documents the trade-off in docs/transcript/README.md.
 */
export async function createUpload(
  env: Env,
  db: Db,
  input: {
    tenantId: string | null;
    guestId: string | null;
    filename: string;
    contentType: string;
    sizeBytes: number;
  },
): Promise<UploadSession> {
  if (!presignConfigured(env)) {
    throw new HttpError("dependency_unavailable", 503, "Uploads are not configured on this deployment.");
  }
  const contentType = input.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!isAllowedMediaType(contentType)) {
    throw new HttpError("invalid_input", 400, "Upload an audio or video file.", { field: "content_type" });
  }
  const limitMb = await uploadLimitMb(db, Boolean(input.tenantId));
  const maxBytes = limitMb * 1024 * 1024;
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > maxBytes) {
    throw new HttpError("invalid_input", 400, `Files must be smaller than ${limitMb} MB.`, {
      field: "size",
      max_bytes: maxBytes,
    });
  }
  const uploadId = id("upl");
  const key = mediaKey(uploadId, input.filename || "upload");
  const expiresInSeconds = 900;
  const url = await presignR2(env, { bucket: "media", key, method: "PUT", expiresIn: expiresInSeconds });
  const timestamp = nowIso();
  await db.run(
    `INSERT INTO upload_sessions
      (id, tenant_id, guest_id, r2_key, upload_id, filename, content_type, size_bytes, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'pending', ?, ?)`,
    [
      uploadId,
      input.tenantId,
      input.guestId,
      key,
      input.filename.slice(0, 200),
      contentType,
      Math.round(input.sizeBytes),
      timestamp,
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ],
  );
  return {
    id: uploadId,
    key,
    url,
    expiresInSeconds,
    filename: input.filename,
    contentType,
    sizeBytes: Math.round(input.sizeBytes),
    maxBytes,
  };
}

export async function getUpload(db: Db, uploadId: string): Promise<UploadRow | null> {
  return db.first<UploadRow>("SELECT * FROM upload_sessions WHERE id = ?", [uploadId]);
}

export async function completeUpload(
  env: Env,
  db: Db,
  uploadId: string,
  owner: { tenantId: string | null; guestId: string | null },
): Promise<UploadRow> {
  const upload = await getUpload(db, uploadId);
  if (!upload) throw new HttpError("not_found", 404, "Upload not found.");
  if (upload.tenant_id !== owner.tenantId || (upload.tenant_id === null && upload.guest_id !== owner.guestId)) {
    throw new HttpError("forbidden", 403, "This upload belongs to another visitor.");
  }
  if (upload.status === "completed") return upload;
  const head = await env.MEDIA.head(upload.r2_key);
  if (!head) throw new HttpError("invalid_input", 400, "The file was not uploaded yet.", { reason: "upload_missing" });
  await db.run("UPDATE upload_sessions SET status = 'completed', completed_at = ? WHERE id = ?", [nowIso(), uploadId]);
  return { ...upload, status: "completed", completed_at: nowIso(), size_bytes: head.size };
}

/** Signed GET for the worker, valid for the whole lease window. */
export async function mediaDownloadUrl(env: Env, key: string, expiresIn = 3600): Promise<string> {
  return presignR2(env, { bucket: "media", key, method: "GET", expiresIn });
}

/** Signed PUT for a result object; the worker uploads then calls `complete`. */
export async function resultUploadUrl(env: Env, key: string, expiresIn = 3600): Promise<string> {
  return presignR2(env, { bucket: "outputs", key, method: "PUT", expiresIn });
}
