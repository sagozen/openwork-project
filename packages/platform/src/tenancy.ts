import type { Db } from "./db";
import { id, nowIso } from "./db";
import type { Profile } from "./types";

interface ProfileRow {
  user_id: string;
  tenant_id: string;
  display_name: string;
  ui_language: "en" | "vi";
  doc_language: "en" | "vi";
  default_retention_seconds: number;
  number_locale: string;
  date_locale: string;
  low_balance_email: number;
  created_at: string;
  updated_at: string;
}

export function mapProfile(row: ProfileRow): Profile {
  return {
    userId: row.user_id,
    tenantId: row.tenant_id,
    displayName: row.display_name,
    uiLanguage: row.ui_language,
    docLanguage: row.doc_language,
    defaultRetentionSeconds: row.default_retention_seconds,
    numberLocale: row.number_locale,
    dateLocale: row.date_locale,
    lowBalanceEmail: row.low_balance_email === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Each account owns exactly one tenant in V1. The tenant id is generated server-side
 * and never accepted from a client. Idempotent so auth hooks and lazy repair can both
 * call it.
 */
export async function ensureTenant(db: Db, user: { id: string; email: string; name?: string }): Promise<string> {
  const existing = await db.first<{ tenant_id: string }>("SELECT tenant_id FROM memberships WHERE user_id = ?", [
    user.id,
  ]);
  if (existing) return existing.tenant_id;

  const tenantId = id("ten");
  const timestamp = nowIso();
  const displayName = (user.name?.trim() || user.email.split("@")[0] || "Account").slice(0, 120);
  await db.batch([
    { sql: "INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)", params: [tenantId, displayName, timestamp] },
    {
      sql: "INSERT INTO memberships (user_id, tenant_id, role, created_at) VALUES (?, ?, 'owner', ?)",
      params: [user.id, tenantId, timestamp],
    },
    {
      sql: `INSERT INTO profiles
            (user_id, tenant_id, display_name, ui_language, doc_language, default_retention_seconds, number_locale, date_locale, low_balance_email, created_at, updated_at)
            VALUES (?, ?, ?, 'en', 'en', 3600, 'en-US', 'en-GB', 0, ?, ?)`,
      params: [user.id, tenantId, displayName, timestamp, timestamp],
    },
  ]);
  return tenantId;
}

export async function getProfile(db: Db, userId: string): Promise<Profile | null> {
  const row = await db.first<ProfileRow>("SELECT * FROM profiles WHERE user_id = ?", [userId]);
  return row ? mapProfile(row) : null;
}

export async function requireProfile(db: Db, user: { id: string; email: string; name?: string }): Promise<Profile> {
  const tenantId = await ensureTenant(db, user);
  const profile = await getProfile(db, user.id);
  if (!profile) throw new Error(`Profile missing for tenant ${tenantId}`);
  return profile;
}

export interface SettingsInput {
  displayName?: string;
  uiLanguage?: "en" | "vi";
  docLanguage?: "en" | "vi";
  defaultRetentionSeconds?: number;
  numberLocale?: string;
  dateLocale?: string;
  lowBalanceEmail?: boolean;
}

export interface ValidationIssue {
  field: string;
  message: string;
}

const RETENTIONS = new Set([3600, 86400, 604800, 2592000]);
const NUMBER_LOCALES = new Set(["en-US", "en-GB", "vi-VN"]);
const DATE_LOCALES = new Set(["en-GB", "en-US", "vi-VN"]);

export function validateSettings(input: SettingsInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (input.displayName !== undefined && (input.displayName.trim().length < 1 || input.displayName.length > 120)) {
    issues.push({ field: "displayName", message: "Use between 1 and 120 characters." });
  }
  if (input.uiLanguage !== undefined && !["en", "vi"].includes(input.uiLanguage)) {
    issues.push({ field: "uiLanguage", message: "Choose en or vi." });
  }
  if (input.docLanguage !== undefined && !["en", "vi"].includes(input.docLanguage)) {
    issues.push({ field: "docLanguage", message: "Choose en or vi." });
  }
  if (input.defaultRetentionSeconds !== undefined && !RETENTIONS.has(input.defaultRetentionSeconds)) {
    issues.push({ field: "defaultRetentionSeconds", message: "Choose 1 hour, 24 hours, 7 days or 30 days." });
  }
  if (input.numberLocale !== undefined && !NUMBER_LOCALES.has(input.numberLocale)) {
    issues.push({ field: "numberLocale", message: "Unsupported number locale." });
  }
  if (input.dateLocale !== undefined && !DATE_LOCALES.has(input.dateLocale)) {
    issues.push({ field: "dateLocale", message: "Unsupported date locale." });
  }
  return issues;
}

export async function updateSettings(db: Db, profile: Profile, input: SettingsInput): Promise<Profile> {
  const issues = validateSettings(input);
  if (issues.length > 0) throw new SettingsValidationError(issues);
  const next = {
    displayName: input.displayName?.trim() ?? profile.displayName,
    uiLanguage: input.uiLanguage ?? profile.uiLanguage,
    docLanguage: input.docLanguage ?? profile.docLanguage,
    defaultRetentionSeconds: input.defaultRetentionSeconds ?? profile.defaultRetentionSeconds,
    numberLocale: input.numberLocale ?? profile.numberLocale,
    dateLocale: input.dateLocale ?? profile.dateLocale,
    lowBalanceEmail: input.lowBalanceEmail ?? profile.lowBalanceEmail,
  };
  const updatedAt = nowIso();
  await db.run(
    `UPDATE profiles SET display_name=?, ui_language=?, doc_language=?, default_retention_seconds=?, number_locale=?, date_locale=?, low_balance_email=?, updated_at=?
     WHERE user_id=? AND tenant_id=?`,
    [
      next.displayName,
      next.uiLanguage,
      next.docLanguage,
      next.defaultRetentionSeconds,
      next.numberLocale,
      next.dateLocale,
      next.lowBalanceEmail ? 1 : 0,
      updatedAt,
      profile.userId,
      profile.tenantId,
    ],
  );
  await audit(db, {
    tenantId: profile.tenantId,
    actorUserId: profile.userId,
    action: "settings.updated",
    targetType: "profile",
    targetId: profile.userId,
    metadata: { fields: Object.keys(input) },
  });
  return { ...profile, ...next, updatedAt };
}

export class SettingsValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super("invalid_settings");
  }
}

export async function audit(
  db: Db,
  entry: {
    tenantId?: string | null;
    actorUserId?: string | null;
    action: string;
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db.run(
    `INSERT INTO audit_log (id, tenant_id, actor_user_id, action, target_type, target_id, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id("aud"),
      entry.tenantId ?? null,
      entry.actorUserId ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      JSON.stringify(entry.metadata ?? {}),
      nowIso(),
    ],
  );
}
