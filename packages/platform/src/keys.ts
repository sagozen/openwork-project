import { platformConfig } from "./config";
import type { Db } from "./db";
import { id, nowIso } from "./db";
import { sendTransactionalEmail } from "./emails/send";
import { HttpError } from "./http";
import { audit } from "./tenancy";
import type { AuthUser, PlatformEnv, Profile } from "./types";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function apiKeyPrefix(): string {
  return platformConfig().apiKeyPrefix ?? "td";
}

function keyPattern(): RegExp {
  return new RegExp(`^${apiKeyPrefix()}_(live|test)_([A-Za-z0-9]{32})([A-Za-z0-9]{6})$`);
}

function availableScopes(): Set<string> {
  return new Set(platformConfig().scopes.available);
}

function randomBase62(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let value = "";
  for (const byte of bytes) value += BASE62[byte % 62];
  return value;
}

function crc32(value: string): number {
  let crc = 0xffffffff;
  for (let index = 0; index < value.length; index += 1) {
    crc ^= value.charCodeAt(index);
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function checksum(value: string): string {
  let number = crc32(value);
  let encoded = "";
  for (let index = 0; index < 6; index += 1) {
    encoded += BASE62[number % 62];
    number = Math.floor(number / 62);
  }
  return encoded.padStart(6, "0");
}

export function generateApiKey(livemode: boolean): string {
  const body = `${apiKeyPrefix()}_${livemode ? "live" : "test"}_${randomBase62(32)}`;
  return `${body}${checksum(body)}`;
}

export function publicPrefix(key: string): string {
  const match = keyPattern().exec(key);
  if (!match) return key.slice(0, 12);
  return `${apiKeyPrefix()}_${match[1]}_${match[2].slice(0, 8)}`;
}

export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isWellFormedApiKey(key: string): boolean {
  const match = keyPattern().exec(key);
  if (!match) return false;
  return checksum(`${apiKeyPrefix()}_${match[1]}_${match[2]}`) === match[3];
}

export interface ApiKeyRow {
  id: string;
  tenant_id: string;
  user_id: string;
  name: string;
  prefix: string;
  hash: string;
  scopes: string;
  spend_cap_daily: number | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface ApiKeyMetadata {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  spendCapDaily: number | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function mapApiKey(row: ApiKeyRow): ApiKeyMetadata {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: JSON.parse(row.scopes) as string[],
    spendCapDaily: row.spend_cap_daily,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

export interface CreateApiKeyInput {
  name: string;
  scopes?: string[];
  spendCapDaily?: number | null;
  livemode?: boolean;
}

export async function createApiKey(
  env: PlatformEnv,
  db: Db,
  context: { user: AuthUser; tenantId: string; profile: Profile },
  input: CreateApiKeyInput,
): Promise<{ key: string; metadata: ApiKeyMetadata }> {
  if (!context.user.emailVerified) {
    throw new HttpError("forbidden", 403, "Verify your email before creating an API key.", {
      reason: "email_unverified",
    });
  }
  const name = input.name?.trim();
  if (!name || name.length > 80) {
    throw new HttpError("invalid_input", 400, "Key name must be between 1 and 80 characters.", {
      errors: [{ field: "name", message: "Use 1–80 characters." }],
    });
  }
  const scopes = input.scopes ?? platformConfig().scopes.default;
  const allowed = availableScopes();
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((scope) => !allowed.has(scope))) {
    throw new HttpError("invalid_input", 400, "Unknown API key scope.", { errors: [{ field: "scopes" }] });
  }
  const cap = input.spendCapDaily ?? null;
  if (cap !== null && (!Number.isInteger(cap) || cap < 1 || cap > 1_000_000)) {
    throw new HttpError("invalid_input", 400, "Daily cap must be between 1 and 1,000,000 credits.", {
      errors: [{ field: "spendCapDaily" }],
    });
  }

  const key = generateApiKey(input.livemode ?? true);
  const keyId = id("key");
  const createdAt = nowIso();
  await db.run(
    `INSERT INTO api_keys (id, tenant_id, user_id, name, prefix, hash, scopes, spend_cap_daily, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      keyId,
      context.tenantId,
      context.user.id,
      name,
      publicPrefix(key),
      await hashApiKey(key),
      JSON.stringify(scopes),
      cap,
      createdAt,
    ],
  );
  await audit(db, {
    tenantId: context.tenantId,
    actorUserId: context.user.id,
    action: "api_key.created",
    targetType: "api_key",
    targetId: keyId,
    metadata: { scopes, hasCap: cap !== null },
  });
  await sendTransactionalEmail(env, db, {
    userId: context.user.id,
    to: context.user.email,
    locale: context.profile.uiLanguage,
    template: "key_created",
    data: { keyName: name },
  });
  const row = await db.first<ApiKeyRow>("SELECT * FROM api_keys WHERE id = ? AND tenant_id = ?", [
    keyId,
    context.tenantId,
  ]);
  if (!row) throw new Error("API key was not stored");
  return { key, metadata: mapApiKey(row) };
}

export async function listApiKeys(db: Db, tenantId: string): Promise<ApiKeyMetadata[]> {
  const rows = await db.all<ApiKeyRow>("SELECT * FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC", [
    tenantId,
  ]);
  return rows.map(mapApiKey);
}

export async function revokeApiKey(
  env: PlatformEnv,
  db: Db,
  context: { user: AuthUser; tenantId: string; profile: Profile },
  keyId: string,
): Promise<ApiKeyMetadata> {
  const row = await db.first<ApiKeyRow>("SELECT * FROM api_keys WHERE id = ? AND tenant_id = ?", [
    keyId,
    context.tenantId,
  ]);
  if (!row) throw new HttpError("not_found", 404);
  const revokedAt = nowIso();
  await db.run("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND tenant_id = ?", [
    revokedAt,
    keyId,
    context.tenantId,
  ]);
  await audit(db, {
    tenantId: context.tenantId,
    actorUserId: context.user.id,
    action: "api_key.revoked",
    targetType: "api_key",
    targetId: keyId,
  });
  await sendTransactionalEmail(env, db, {
    userId: context.user.id,
    to: context.user.email,
    locale: context.profile.uiLanguage,
    template: "key_revoked",
    data: { keyName: row.name },
  });
  return mapApiKey({ ...row, revoked_at: revokedAt });
}

export interface ApiKeyPrincipal {
  tenantId: string;
  userId: string;
  keyId: string;
  scopes: string[];
  livemode: boolean;
}

/** Refuses a key that does not carry the scope an endpoint requires. */
export function requireApiKeyScope(principal: ApiKeyPrincipal, scope: string): void {
  if (!principal.scopes.includes(scope)) {
    throw new HttpError("forbidden", 403, "This API key does not have the required scope.", {
      required: scope,
      scopes: principal.scopes,
    });
  }
}

/** Returns null for malformed, unknown, revoked or deleted keys. */
export async function authenticateApiKey(db: Db, key: string): Promise<ApiKeyPrincipal | null> {
  if (!isWellFormedApiKey(key)) return null;
  const hash = await hashApiKey(key);
  const row = await db.first<ApiKeyRow>("SELECT * FROM api_keys WHERE hash = ? AND revoked_at IS NULL", [hash]);
  if (!row) return null;
  await db.run("UPDATE api_keys SET last_used_at = ? WHERE id = ?", [nowIso(), row.id]);
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    keyId: row.id,
    scopes: JSON.parse(row.scopes) as string[],
    livemode: keyPattern().exec(key)?.[1] === "live",
  };
}
