import type { Db } from "@templatedesign/platform/db";
import { d1Db } from "@templatedesign/platform/db";
import type { z } from "zod";
import { ArtifactError } from "../artifacts/errors";
import { type ArtifactOut, type ArtifactRow, toArtifactOut } from "../artifacts/service";
import type { Caller } from "../auth/caller";
import { assertScope, SCOPE_READ, SCOPE_WRITE } from "../auth/scopes";
import { ARTIFACT_ID_PATTERN, newArtifactId } from "../storage/keys";
import { type Storage, storageFromEnv } from "../storage/s3";
import type { Env } from "../types";
import { generatePassword, hashPassword } from "./crypto";
import {
  type CreateShareInput,
  createShareSchema,
  GENERATE_PASSWORD,
  type ListSharesInput,
  listSharesSchema,
  type UpdateShareInput,
  updateShareSchema,
} from "./schemas";

export interface ShareDeps {
  db: Db;
  storage: Storage;
  /** Public origin of the app, the base of every share URL. */
  origin: string;
  /** Origin of the object store, the only host share pages may load media from. */
  storageOrigin: string;
  /** Server secret that signs the password cookie. */
  secret: string;
  now?: () => Date;
}

export function shareDeps(env: Env): ShareDeps {
  return {
    db: d1Db(env.DB),
    storage: storageFromEnv(env),
    origin: new URL(env.APP_ORIGIN).origin,
    storageOrigin: new URL(env.S3_ENDPOINT).origin,
    secret: env.BETTER_AUTH_SECRET,
  };
}

export interface ShareRow {
  id: string;
  tenant_id: string;
  title: string | null;
  password_hash: string | null;
  password_salt: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  view_count: number;
  download_count: number;
  last_viewed_at: string | null;
  created_at: string;
}

export type ShareState = "active" | "revoked" | "expired";

export interface ShareOut {
  id: string;
  url: string;
  title: string | null;
  has_password: boolean;
  state: ShareState;
  expires_at: string | null;
  revoked_at: string | null;
  view_count: number;
  download_count: number;
  last_viewed_at: string | null;
  created_at: string;
  item_count: number;
}

export interface ShareDetail extends ShareOut {
  items: Array<Pick<ArtifactOut, "id" | "name" | "mime" | "size" | "status">>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const now = (deps: ShareDeps) => (deps.now ?? (() => new Date()))();
const nowIso = (deps: ShareDeps) => now(deps).toISOString();
const shareUrl = (deps: ShareDeps, id: string) => `${deps.origin}/s/${id}`;

function stateOf(deps: ShareDeps, row: ShareRow): ShareState {
  if (row.revoked_at) return "revoked";
  return row.expires_at !== null && row.expires_at <= nowIso(deps) ? "expired" : "active";
}

function toShareOut(deps: ShareDeps, row: ShareRow, itemCount: number): ShareOut {
  return {
    id: row.id,
    url: shareUrl(deps, row.id),
    title: row.title,
    has_password: row.password_hash !== null,
    state: stateOf(deps, row),
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    view_count: row.view_count,
    download_count: row.download_count,
    last_viewed_at: row.last_viewed_at,
    created_at: row.created_at,
    item_count: itemCount,
  };
}

function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  return schema.parse(input);
}

/** Items are counted over files that can still be served, so a bundle shows what a visitor would see. */
const LIVE_ITEMS_SQL = `SELECT COUNT(*) AS n FROM share_items si
  JOIN artifacts a ON a.id = si.artifact_id AND a.tenant_id = si.tenant_id
  WHERE si.share_id = ? AND si.tenant_id = ? AND a.status = 'ready' AND (a.expires_at IS NULL OR a.expires_at > ?)`;

async function countLiveItems(deps: ShareDeps, tenantId: string, shareId: string): Promise<number> {
  const row = await deps.db.first<{ n: number }>(LIVE_ITEMS_SQL, [shareId, tenantId, nowIso(deps)]);
  return row?.n ?? 0;
}

async function requireShare(deps: ShareDeps, caller: Caller, id: string): Promise<ShareRow> {
  const notFound = new ArtifactError("NOT_FOUND", "No share with that id.");
  if (!ARTIFACT_ID_PATTERN.test(id)) throw notFound;
  const row = await deps.db.first<ShareRow>("SELECT * FROM shares WHERE id = ? AND tenant_id = ?", [
    id,
    caller.tenantId,
  ]);
  if (!row) throw notFound;
  return row;
}

/* ------------------------------------------------------------------- owner */

export interface CreatedShare {
  share_id: string;
  url: string;
  title: string | null;
  has_password: boolean;
  /** Present only when the password was generated here; it is not stored and cannot be shown again. */
  password?: string;
  expires_at: string | null;
}

/**
 * Publishes 1 to 50 of the caller's ready files behind `/s/<token>`, optionally password protected
 * and optionally expiring. Every file must belong to the caller and still be servable.
 */
export async function createShare(deps: ShareDeps, caller: Caller, input: CreateShareInput): Promise<CreatedShare> {
  assertScope(caller, SCOPE_WRITE);
  const parsed = parseInput(createShareSchema, input);

  const ids = parsed.artifact_ids;
  const found = await deps.db.all<{ id: string }>(
    `SELECT id FROM artifacts WHERE tenant_id = ? AND status = 'ready' AND (expires_at IS NULL OR expires_at > ?)
     AND id IN (${ids.map(() => "?").join(", ")})`,
    [caller.tenantId, nowIso(deps), ...ids],
  );
  const have = new Set(found.map((row) => row.id));
  const missing = ids.filter((id) => !have.has(id));
  if (missing.length > 0) {
    throw new ArtifactError("NOT_FOUND", "Some of those files do not exist or are not ready to share.", {
      missing_ids: missing,
    });
  }

  let password: string | undefined;
  let secret: { hash: string; salt: string } | null = null;
  if (parsed.password !== undefined) {
    password = parsed.password === GENERATE_PASSWORD ? generatePassword() : parsed.password;
    secret = await hashPassword(password);
  }

  const id = newArtifactId();
  const created = nowIso(deps);
  const expiresAt =
    parsed.expires_in_days === undefined
      ? null
      : new Date(now(deps).getTime() + parsed.expires_in_days * DAY_MS).toISOString();
  await deps.db.batch([
    {
      sql: `INSERT INTO shares (id, tenant_id, title, password_hash, password_salt, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        id,
        caller.tenantId,
        parsed.title ?? null,
        secret?.hash ?? null,
        secret?.salt ?? null,
        expiresAt,
        created,
      ],
    },
    ...ids.map((artifactId, position) => ({
      sql: "INSERT INTO share_items (share_id, tenant_id, artifact_id, position) VALUES (?, ?, ?, ?)",
      params: [id, caller.tenantId, artifactId, position],
    })),
  ]);
  return {
    share_id: id,
    url: shareUrl(deps, id),
    title: parsed.title ?? null,
    has_password: secret !== null,
    ...(parsed.password === GENERATE_PASSWORD ? { password } : {}),
    expires_at: expiresAt,
  };
}

export interface SharePage {
  items: ShareOut[];
  next_cursor: string | null;
}

function encodeCursor(row: Pick<ShareRow, "created_at" | "id">): string {
  return btoa(`${row.created_at}|${row.id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const [createdAt, id] = atob(cursor.replace(/-/g, "+").replace(/_/g, "/")).split("|");
    if (createdAt && id && ARTIFACT_ID_PATTERN.test(id) && !Number.isNaN(Date.parse(createdAt)))
      return { createdAt, id };
  } catch {
    // Falls through to the error below.
  }
  throw new ArtifactError("INVALID_INPUT", "That cursor is not valid. Start again without one.");
}

/** The caller's shares, newest first. Revoked ones are left out unless asked for. */
export async function listShares(deps: ShareDeps, caller: Caller, input: ListSharesInput = {}): Promise<SharePage> {
  assertScope(caller, SCOPE_READ);
  const parsed = parseInput(listSharesSchema, input);
  const clauses: string[] = [];
  const params: unknown[] = [caller.tenantId];
  if (!parsed.include_revoked) clauses.push("revoked_at IS NULL");
  if (parsed.cursor) {
    const { createdAt, id } = decodeCursor(parsed.cursor);
    clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
    params.push(createdAt, createdAt, id);
  }
  const rows = await deps.db.all<ShareRow>(
    `SELECT * FROM shares WHERE tenant_id = ? ${clauses.map((clause) => `AND ${clause}`).join(" ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
    [...params, parsed.limit + 1],
  );
  const page = rows.slice(0, parsed.limit);
  const items = await Promise.all(
    page.map(async (row) => toShareOut(deps, row, await countLiveItems(deps, caller.tenantId, row.id))),
  );
  return { items, next_cursor: rows.length > parsed.limit ? encodeCursor(page[page.length - 1]) : null };
}

export async function getShare(deps: ShareDeps, caller: Caller, id: string): Promise<ShareDetail> {
  assertScope(caller, SCOPE_READ);
  const row = await requireShare(deps, caller, id);
  const files = await deps.db.all<ArtifactRow>(
    `SELECT a.* FROM share_items si
     JOIN artifacts a ON a.id = si.artifact_id AND a.tenant_id = si.tenant_id
     WHERE si.share_id = ? AND si.tenant_id = ?
     ORDER BY si.position`,
    [row.id, caller.tenantId],
  );
  const live = files.filter(
    (file) => file.status === "ready" && (file.expires_at === null || file.expires_at > nowIso(deps)),
  );
  return {
    ...toShareOut(deps, row, live.length),
    items: live.map((file) => {
      const { id: fileId, name, mime, size, status } = toArtifactOut(file);
      return { id: fileId, name, mime, size, status };
    }),
  };
}

/** Changes a share's title, expiry or password. A new or removed password signs every visitor out. */
export async function updateShare(
  deps: ShareDeps,
  caller: Caller,
  id: string,
  input: UpdateShareInput,
): Promise<ShareOut & { password?: string }> {
  assertScope(caller, SCOPE_WRITE);
  const parsed = parseInput(updateShareSchema, input);
  const row = await requireShare(deps, caller, id);

  const sets: string[] = [];
  const params: unknown[] = [];
  let generated: string | undefined;
  if (parsed.title !== undefined) {
    sets.push("title = ?");
    params.push(parsed.title);
  }
  if (parsed.expires_in_days !== undefined) {
    sets.push("expires_at = ?");
    params.push(
      parsed.expires_in_days === null
        ? null
        : new Date(now(deps).getTime() + parsed.expires_in_days * DAY_MS).toISOString(),
    );
  }
  if (parsed.password !== undefined) {
    if (parsed.password === null) {
      sets.push("password_hash = NULL", "password_salt = NULL");
    } else {
      const password = parsed.password === GENERATE_PASSWORD ? generatePassword() : parsed.password;
      if (parsed.password === GENERATE_PASSWORD) generated = password;
      const secret = await hashPassword(password);
      sets.push("password_hash = ?", "password_salt = ?");
      params.push(secret.hash, secret.salt);
    }
  }
  await deps.db.run(`UPDATE shares SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`, [
    ...params,
    row.id,
    caller.tenantId,
  ]);

  const updated = await requireShare(deps, caller, id);
  const out = toShareOut(deps, updated, await countLiveItems(deps, caller.tenantId, row.id));
  return generated === undefined ? out : { ...out, password: generated };
}

/** Switches a share off. Repeating the call keeps the first revocation time. */
export async function revokeShare(deps: ShareDeps, caller: Caller, id: string): Promise<ShareOut> {
  assertScope(caller, SCOPE_WRITE);
  const row = await requireShare(deps, caller, id);
  await deps.db.run("UPDATE shares SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND tenant_id = ?", [
    nowIso(deps),
    row.id,
    caller.tenantId,
  ]);
  const updated = await requireShare(deps, caller, id);
  return toShareOut(deps, updated, await countLiveItems(deps, caller.tenantId, row.id));
}

/* ------------------------------------------------------------------ public */

export type ShareUnavailableReason = "not_found" | "revoked" | "expired" | "gone";

/** A share that cannot be served: 404 when the token is unknown, 410 when it existed and is over. */
export class ShareUnavailableError extends Error {
  constructor(
    readonly reason: ShareUnavailableReason,
    readonly status: 404 | 410,
  ) {
    super(`Share unavailable: ${reason}`);
    this.name = "ShareUnavailableError";
  }
}

export interface ResolvedShare {
  share: ShareRow;
  /** The files still servable, in the order they were shared. */
  items: ArtifactRow[];
}

/**
 * Looks a share up by its token, the one lookup that starts from no tenant: the 128-bit token is
 * the capability. Everything after it is scoped to the share's own tenant. Unknown tokens are 404;
 * revoked, expired and emptied shares (every file deleted or expired) are 410.
 */
export async function resolveShare(deps: ShareDeps, token: string): Promise<ResolvedShare> {
  if (!ARTIFACT_ID_PATTERN.test(token)) throw new ShareUnavailableError("not_found", 404);
  const share = await deps.db.first<ShareRow>("SELECT * FROM shares WHERE id = ?", [token]);
  if (!share) throw new ShareUnavailableError("not_found", 404);
  if (share.revoked_at) throw new ShareUnavailableError("revoked", 410);
  if (share.expires_at !== null && share.expires_at <= nowIso(deps)) throw new ShareUnavailableError("expired", 410);
  const items = await deps.db.all<ArtifactRow>(
    `SELECT a.* FROM share_items si
     JOIN artifacts a ON a.id = si.artifact_id AND a.tenant_id = si.tenant_id
     WHERE si.share_id = ? AND si.tenant_id = ? AND a.status = 'ready' AND (a.expires_at IS NULL OR a.expires_at > ?)
     ORDER BY si.position`,
    [share.id, share.tenant_id, nowIso(deps)],
  );
  if (items.length === 0) throw new ShareUnavailableError("gone", 410);
  return { share, items };
}

/** Counters are informational only: there is no download limit. */
export async function recordShareView(deps: ShareDeps, share: ShareRow): Promise<void> {
  await deps.db.run(
    "UPDATE shares SET view_count = view_count + 1, last_viewed_at = ? WHERE id = ? AND tenant_id = ?",
    [nowIso(deps), share.id, share.tenant_id],
  );
}

export async function recordShareDownload(deps: ShareDeps, share: ShareRow): Promise<void> {
  await deps.db.run(
    "UPDATE shares SET download_count = download_count + 1, last_viewed_at = ? WHERE id = ? AND tenant_id = ?",
    [nowIso(deps), share.id, share.tenant_id],
  );
}
