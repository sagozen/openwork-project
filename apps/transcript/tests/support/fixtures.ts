import { ensureWallet, type LedgerRow, type Wallet } from "@templatedesign/platform/credits";
import type { Db } from "@templatedesign/platform/db";
import { ensureTenant, getProfile } from "@templatedesign/platform/tenancy";
import type { AuthUser, Profile } from "@templatedesign/platform/types";
import type { Env } from "../../src/lib/types";

export class MemoryBucket {
  readonly objects = new Map<string, Uint8Array>();
  async put(key: string, value: string | ArrayBuffer | Uint8Array): Promise<void> {
    const bytes =
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
          ? new Uint8Array(value)
          : new Uint8Array(value);
    this.objects.set(key, bytes);
  }
  async get(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return {
      text: async () => new TextDecoder().decode(bytes),
      json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    };
  }
  async head(key: string) {
    return this.objects.has(key) ? { size: this.objects.get(key)?.byteLength ?? 0 } : null;
  }
  async list({ prefix }: { prefix: string }) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix));
    return { objects: keys.map((key) => ({ key })), truncated: false, cursor: undefined };
  }
  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
}

export function testEnv(): Env {
  return {
    DB: {} as D1Database,
    MEDIA: new MemoryBucket() as unknown as R2Bucket,
    OUTPUTS: new MemoryBucket() as unknown as R2Bucket,
    BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_URL: "http://localhost:4323",
    APP_ORIGIN: "http://localhost:4323",
    EMAIL_PROVIDER: "console",
    EMAIL_FROM: "TranscriptAnything <no-reply@localhost>",
    ADMIN_EMAILS: "ops@example.com",
  };
}

let counter = 0;

export async function createAccount(
  db: Db,
  options: { credits?: number; verified?: boolean } = {},
): Promise<{ user: AuthUser; profile: Profile; tenantId: string }> {
  counter += 1;
  const user: AuthUser = {
    id: `usr_test_${counter}`,
    email: `user${counter}@example.com`,
    name: `User ${counter}`,
    emailVerified: options.verified ?? true,
  };
  const timestamp = new Date().toISOString();
  await db.run('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)', [
    user.id,
    user.name,
    user.email,
    user.emailVerified ? 1 : 0,
    timestamp,
    timestamp,
  ]);
  const tenantId = await ensureTenant(db, user);
  await ensureWallet(db, tenantId);
  if (options.credits) {
    await db.run("UPDATE wallets SET purchased_balance = ? WHERE tenant_id = ?", [options.credits, tenantId]);
    await db.run(
      "INSERT INTO ledger_entries (id, tenant_id, kind, credits, source, created_at) VALUES (?, ?, 'grant', ?, 'purchased', ?)",
      [`led_seed_${tenantId}`, tenantId, options.credits, timestamp],
    );
  }
  const profile = await getProfile(db, user.id);
  if (!profile) throw new Error("profile missing");
  return { user, profile, tenantId };
}

export async function walletOf(db: Db, tenantId: string): Promise<Wallet> {
  const row = await db.first<{ free_balance: number; purchased_balance: number; reserved_credits: number }>(
    "SELECT free_balance, purchased_balance, reserved_credits FROM wallets WHERE tenant_id = ?",
    [tenantId],
  );
  const free = row?.free_balance ?? 0;
  const purchased = row?.purchased_balance ?? 0;
  const reserved = row?.reserved_credits ?? 0;
  return { free, purchased, reserved, available: free + purchased - reserved, freeResetAt: "" };
}

export async function ledgerOf(db: Db, tenantId: string): Promise<LedgerRow[]> {
  return db.all<LedgerRow>(
    "SELECT id, kind, credits, source, job_id, created_at FROM ledger_entries WHERE tenant_id = ? ORDER BY created_at",
    [tenantId],
  );
}

export function minutesUsed(db: Db, tenantId: string): Promise<number> {
  return db
    .first<{ minutes_used: number }>("SELECT minutes_used FROM minute_usage WHERE tenant_id = ?", [tenantId])
    .then((row) => row?.minutes_used ?? 0);
}
