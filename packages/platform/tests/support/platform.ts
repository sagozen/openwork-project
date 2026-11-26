import type { AdminActor } from "../../src/admin";
import { createPlatform, type PlatformConfig } from "../../src/config";

/**
 * A deliberately different product from templatedesign: different name, prices, guest
 * allowance, scopes, webhook events and admin hooks. If a platform module leaks a
 * templatedesign value, the assertions in `platform.test.ts` fail.
 */
const config: PlatformConfig = {
  brand: {
    name: "TestProduct",
    appOrigin: "https://test.example",
    emailFrom: "TestProduct <no-reply@test.example>",
  },
  packs: [{ id: "starter", name: { en: "Starter", vi: "Starter" }, priceCents: 1000, credits: 1000 }],
  guestPolicy: {
    dailyCredits: 2,
    exceedingMessage: (_locale, input) => `Test files are limited to ${input.allowed} per day.`,
    exhaustedMessage: (_locale, input) =>
      `Guest quota is used up. Sign in for ${input.freeMonthlyCredits} free credits.`,
    signupPath: "/auth/sign-in",
  },
  copy: {
    welcomeBody: { en: ["Welcome."], vi: ["Chào mừng."] },
    dataNoun: { en: "transcripts", vi: "bản ghi" },
  },
  locales: ["en", "vi"],
  scopes: {
    available: ["transcriptions:write", "transcriptions:read", "usage:read"],
    default: ["transcriptions:write", "transcriptions:read"],
  },
  apiKeyPrefix: "tt",
  webhooks: { events: ["transcription.completed", "transcription.failed", "webhook.test"] },
  admin: {
    loadProductMetrics: async () => ({
      jobs24h: 3,
      failures24h: 1,
      queued: 1,
      running: 0,
      avgDurationMs: 1200,
      p95DurationMs: 2000,
      queueAgeMs: 5000,
      failureByCode: [{ code: "source_unavailable", count: 1 }],
      failureByLabel: [{ label: "gdrive", count: 1 }],
    }),
    extraSettings: [{ key: "transcript.monthly_cap_minutes", kind: "number", max: 100_000 }],
  },
};

export function configureTestPlatform(overrides: Partial<PlatformConfig> = {}): PlatformConfig {
  return createPlatform({ ...config, ...overrides });
}

export function proposeTestActor(): AdminActor {
  return { userId: "usr_admin", email: "admin@example.com", role: "admin" };
}
