import type { AccountJobRow } from "@templatedesign/platform/config";
import { createPlatform } from "@templatedesign/platform/config";
import type { Db } from "@templatedesign/platform/db";
import { transcriptCrm } from "./crm";
import { CREDIT_PACKS } from "./packs";

/**
 * TranscriptAnything's row in the shared platform. Imported by `src/worker.ts`, the middleware,
 * the pages that touch platform modules and the tests.
 */
export const platform = createPlatform({
  brand: {
    name: "TranscriptAnything",
    appOrigin: "https://transcriptanything.zhst.app",
    emailFrom: "TranscriptAnything <no-reply@transcriptanything.zhst.app>",
    supportEmail: "support.transcriptanything@zhst.app",
    developersPath: "/?account=api",
    settingsPath: "/?account=settings",
    topupPath: "/?topup=1",
    checkoutReturnPath: "/?payment={payment}",
    checkoutCancelPath: "/?topup=1&checkout=cancelled",
    reconciliationPath: "/admin/reconciliation/",
  },
  packs: CREDIT_PACKS,
  guestPolicy: {
    dailyCredits: 5,
    exceedingMessage: (locale) =>
      locale === "vi" ? "Khách chỉ được 5 tệp miễn phí mỗi ngày." : "Guests get 5 free transcriptions per day.",
    exhaustedMessage: (locale) =>
      locale === "vi"
        ? "Hôm nay bạn đã dùng hết lượt miễn phí. Đăng nhập để có 25 lượt mỗi ngày."
        : "Guest quota is used up for today. Sign in for 25 free transcriptions a day.",
    signupPath: "/auth/sign-in",
  },
  copy: {
    welcomeBody: {
      en: [
        "Paste a Drive, YouTube or direct link, or upload a file, and get a transcript with timestamps.",
        "Media under 3 minutes is free. Longer media uses credits, and every account has a monthly minute cap.",
      ],
      vi: [
        "Dán liên kết Drive, YouTube hoặc liên kết trực tiếp, hoặc tải tệp lên, để nhận bản ghi kèm mốc thời gian.",
        "Tệp dưới 3 phút miễn phí. Tệp dài hơn dùng credit và mỗi tài khoản có hạn mức phút hàng tháng.",
      ],
    },
    dataNoun: { en: "audio files and transcripts", vi: "tệp âm thanh và bản ghi" },
  },
  locales: ["en", "vi"],
  scopes: {
    available: ["transcriptions:write", "transcriptions:read", "usage:read"],
    default: ["transcriptions:write", "transcriptions:read"],
  },
  apiKeyPrefix: "tt",
  webhooks: { events: ["transcription.completed", "transcription.failed", "webhook.test"] },
  admin: {
    loadAccountJobs: async (db: Db, tenantId: string): Promise<AccountJobRow[]> => {
      const rows = await db.all<{
        id: string;
        source_kind: string;
        status: string;
        billable_minutes: number | null;
        charged_credits: number;
        created_at: string;
        result_key: string | null;
      }>(
        "SELECT id, source_kind, status, billable_minutes, charged_credits, created_at, result_key FROM transcription_jobs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 10",
        [tenantId],
      );
      return rows.map((row) => ({
        id: row.id,
        label: row.source_kind,
        status: row.status,
        chargedCredits: row.charged_credits,
        createdAt: row.created_at,
        resourceId: row.result_key,
        units: row.billable_minutes,
      }));
    },
    loadProductMetrics: async (db: Db) => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const [jobs24h, failures24h, queued, running, avg] = await Promise.all([
        db.first<{ count: number }>("SELECT COUNT(*) AS count FROM transcription_jobs WHERE created_at >= ?", [since]),
        db.first<{ count: number }>(
          "SELECT COUNT(*) AS count FROM transcription_jobs WHERE status='failed' AND created_at >= ?",
          [since],
        ),
        db.first<{ count: number }>("SELECT COUNT(*) AS count FROM transcription_jobs WHERE status='queued'"),
        db.first<{ count: number }>("SELECT COUNT(*) AS count FROM transcription_jobs WHERE status='leased'"),
        db.first<{ avg_ms: number | null }>(
          "SELECT AVG((julianday(finished_at) - julianday(started_at)) * 86400000) AS avg_ms FROM transcription_jobs WHERE finished_at IS NOT NULL AND started_at IS NOT NULL AND created_at >= ?",
          [since],
        ),
      ]);
      const durations = await db.all<{ ms: number }>(
        "SELECT (julianday(finished_at) - julianday(started_at)) * 86400000 AS ms FROM transcription_jobs WHERE finished_at IS NOT NULL AND started_at IS NOT NULL ORDER BY created_at DESC LIMIT 200",
      );
      const sorted = durations.map((row) => row.ms).sort((a, b) => a - b);
      const oldestQueued = await db.first<{ queued_at: string }>(
        "SELECT queued_at FROM transcription_jobs WHERE status='queued' ORDER BY queued_at LIMIT 1",
      );
      const failureByCode = await db.all<{ code: string; count: number }>(
        "SELECT error_code AS code, COUNT(*) AS count FROM transcription_jobs WHERE status='failed' AND error_code IS NOT NULL GROUP BY error_code ORDER BY count DESC LIMIT 10",
      );
      const failureByLabel = await db.all<{ label: string; count: number }>(
        "SELECT COALESCE(source_kind, 'unknown') AS label, COUNT(*) AS count FROM transcription_jobs WHERE status='failed' GROUP BY source_kind ORDER BY count DESC LIMIT 10",
      );
      return {
        jobs24h: jobs24h?.count ?? 0,
        failures24h: failures24h?.count ?? 0,
        queued: queued?.count ?? 0,
        running: running?.count ?? 0,
        avgDurationMs: avg?.avg_ms ?? null,
        p95DurationMs: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null,
        queueAgeMs: oldestQueued ? Date.now() - Date.parse(oldestQueued.queued_at) : null,
        failureByCode,
        failureByLabel,
      };
    },
    extraSettings: [
      { key: "transcript.monthly_cap_minutes", kind: "number", max: 1_000_000 },
      { key: "transcript.free_queue_minutes_per_day", kind: "number", max: 100_000 },
      { key: "transcript.max_upload_mb_free", kind: "number", max: 10_000 },
      { key: "transcript.max_upload_mb_paid", kind: "number", max: 20_000 },
      { key: "transcript.free_queue_max_wait_seconds", kind: "number", max: 86_400 },
      { key: "transcript.free_starvation_seconds", kind: "number", max: 86_400 },
      { key: "transcript.fallback_after_seconds", kind: "number", max: 86_400 },
      { key: "llm.models", kind: "json" },
      { key: "llm.enabled", kind: "boolean" },
      { key: "source.youtube.enabled", kind: "boolean" },
      { key: "source.tiktok.enabled", kind: "boolean" },
      { key: "source.gdrive.enabled", kind: "boolean" },
      { key: "source.onedrive.enabled", kind: "boolean" },
      { key: "source.dropbox.enabled", kind: "boolean" },
      { key: "source.direct.enabled", kind: "boolean" },
      { key: "pause.transcription", kind: "boolean" },
    ],
  },
  deletion: {
    purgeProductData: async (db: Db, tenantId: string) => {
      await db.batch([
        { sql: "DELETE FROM upload_sessions WHERE tenant_id = ?", params: [tenantId] },
        { sql: "DELETE FROM transcription_jobs WHERE tenant_id = ?", params: [tenantId] },
        { sql: "DELETE FROM minute_usage WHERE tenant_id = ?", params: [tenantId] },
        { sql: "DELETE FROM crm_events WHERE tenant_id = ?", params: [tenantId] },
      ]);
    },
  },
  crm: transcriptCrm,
});
