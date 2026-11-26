import type { AccountJobRow } from "@templatedesign/platform/config";
import { createPlatform } from "@templatedesign/platform/config";
import type { Db } from "@templatedesign/platform/db";
import { deleteTenantObjects } from "./images/purge";

/** ImageFactory's row in the shared platform. Imported by the worker, the middleware and the tests. */
export const platform = createPlatform({
  brand: {
    name: "ImageFactory",
    appOrigin: "https://imagefactory.zhst.app",
    emailFrom: "ImageFactory <no-reply@imagefactory.zhst.app>",
    supportEmail: "support@imagefactory.zhst.app",
    developersPath: "/account",
    settingsPath: "/account",
    topupPath: "/account",
    reconciliationPath: "/admin/",
  },
  packs: [],
  guestPolicy: {
    dailyCredits: 0,
    exceedingMessage: () => "Sign in to continue.",
    exhaustedMessage: () => "Sign in to continue.",
    signupPath: "/sign-in",
  },
  copy: {
    welcomeBody: {
      en: [
        "Add ImageFactory to Claude or ChatGPT as a connector, then ask for on-brand images.",
        "Your account page has the connector URL, your credits and your API keys.",
      ],
      vi: [
        "Thêm ImageFactory vào Claude hoặc ChatGPT dưới dạng connector, rồi yêu cầu ảnh đúng thương hiệu.",
        "Trang tài khoản có địa chỉ connector, số credit và khóa API của bạn.",
      ],
    },
    dataNoun: { en: "brand kits and images", vi: "bộ nhận diện và ảnh" },
  },
  locales: ["en"],
  scopes: { available: ["images:read", "images:write"], default: ["images:read", "images:write"] },
  apiKeyPrefix: "if",
  mcp: {
    resourcePath: "/mcp",
    scopes: ["images:read", "images:write", "offline_access"],
    consentPath: "/connect/authorize",
  },
  admin: {
    loadAccountJobs: async (db: Db, tenantId: string): Promise<AccountJobRow[]> => {
      const rows = await db.all<{
        id: string;
        kind: string;
        model: string;
        state: string;
        num_images: number;
        credits_charged: number | null;
        created_at: string;
      }>(
        "SELECT id, kind, model, state, num_images, credits_charged, created_at FROM image_jobs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 10",
        [tenantId],
      );
      return rows.map((row) => ({
        id: row.id,
        label: `${row.kind} · ${row.model}`,
        status: row.state,
        chargedCredits: row.credits_charged ?? 0,
        createdAt: row.created_at,
        resourceId: null,
        units: row.num_images,
      }));
    },
    loadProductMetrics: async (db: Db) => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const count = async (where: string, params: unknown[] = []) =>
        (await db.first<{ count: number }>(`SELECT COUNT(*) AS count FROM image_jobs WHERE ${where}`, params))?.count ??
        0;
      const [jobs24h, failures24h, queued, running] = await Promise.all([
        count("created_at >= ?", [since]),
        count("state = 'failed' AND created_at >= ?", [since]),
        count("state IN ('submitting', 'queued')"),
        count("state IN ('running', 'finalizing')"),
      ]);
      const durations = await db.all<{ ms: number }>(
        "SELECT (julianday(finished_at) - julianday(created_at)) * 86400000 AS ms FROM image_jobs WHERE state = 'done' AND finished_at IS NOT NULL ORDER BY created_at DESC LIMIT 200",
      );
      const sorted = durations.map((row) => row.ms).sort((a, b) => a - b);
      const oldest = await db.first<{ created_at: string }>(
        "SELECT created_at FROM image_jobs WHERE state IN ('submitting', 'queued') ORDER BY created_at LIMIT 1",
      );
      return {
        jobs24h,
        failures24h,
        queued,
        running,
        avgDurationMs: sorted.length ? sorted.reduce((sum, ms) => sum + ms, 0) / sorted.length : null,
        p95DurationMs: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null,
        queueAgeMs: oldest ? Date.now() - Date.parse(oldest.created_at) : null,
        failureByCode: await db.all<{ code: string; count: number }>(
          "SELECT error_code AS code, COUNT(*) AS count FROM image_jobs WHERE state = 'failed' AND error_code IS NOT NULL GROUP BY error_code ORDER BY count DESC LIMIT 10",
        ),
        failureByLabel: await db.all<{ label: string; count: number }>(
          "SELECT model AS label, COUNT(*) AS count FROM image_jobs WHERE state = 'failed' GROUP BY model ORDER BY count DESC LIMIT 10",
        ),
      };
    },
    extraSettings: [
      { key: "generation.enabled", kind: "boolean" },
      { key: "generation.max_images_per_call", kind: "number", max: 4 },
      { key: "generation.rate_per_minute", kind: "number", max: 10_000 },
      { key: "generation.worker_wait_seconds", kind: "number", max: 600 },
      { key: "pricing.qwen-image.credits_per_mp", kind: "number", max: 1000 },
      { key: "pricing.qwen-edit.credits_per_mp", kind: "number", max: 1000 },
    ],
  },
  deletion: {
    purgeProductData: async (db, tenantId) => {
      // Loaded on demand: the Workers runtime module does not exist under the Node test runner.
      const { runtimeEnv } = await import("./runtime");
      await deleteTenantObjects(runtimeEnv().IMAGES, tenantId);
      await db.batch([
        { sql: "DELETE FROM images WHERE tenant_id = ?", params: [tenantId] },
        { sql: "DELETE FROM image_jobs WHERE tenant_id = ?", params: [tenantId] },
        { sql: "DELETE FROM brand_assets WHERE tenant_id = ?", params: [tenantId] },
        { sql: "DELETE FROM brand_kits WHERE tenant_id = ?", params: [tenantId] },
      ]);
    },
  },
});
