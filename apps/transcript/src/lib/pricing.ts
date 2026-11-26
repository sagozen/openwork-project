import { getAdminSettings, getAdminSettingValue } from "@templatedesign/platform/admin";
import type { Db } from "@templatedesign/platform/db";
import { PRICING } from "./pricing-core";

export * from "./pricing-core";

export async function monthlyCapMinutes(db: Db, tenantId: string): Promise<number> {
  const { effectiveQuota } = await import("@templatedesign/platform/admin");
  const override = await effectiveQuota(db, tenantId, "transcript.monthly_cap_minutes");
  if (override !== null) return override;
  const configured = await getAdminSettingValue<number>(db, "transcript.monthly_cap_minutes");
  return typeof configured === "number" ? configured : PRICING.monthlyCapMinutes;
}

export async function freeQueueBudget(db: Db): Promise<{ maxWaitSeconds: number; minutesPerDay: number }> {
  const [wait, minutes] = await Promise.all([
    getAdminSettingValue<number>(db, "transcript.free_queue_max_wait_seconds"),
    getAdminSettingValue<number>(db, "transcript.free_queue_minutes_per_day"),
  ]);
  return {
    maxWaitSeconds: typeof wait === "number" ? wait : PRICING.freeQueueMaxWaitSeconds,
    minutesPerDay: typeof minutes === "number" ? minutes : PRICING.freeQueueMinutesPerDay,
  };
}

export async function fallbackAfterSeconds(db: Db): Promise<number> {
  const value = await getAdminSettingValue<number>(db, "transcript.fallback_after_seconds");
  return typeof value === "number" ? value : PRICING.fallbackAfterSeconds;
}

export async function uploadLimitMb(db: Db, paid: boolean): Promise<number> {
  const key = paid ? "transcript.max_upload_mb_paid" : "transcript.max_upload_mb_free";
  const value = await getAdminSettingValue<number>(db, key);
  const fallback = paid ? PRICING.maxUploadMbPaid : PRICING.maxUploadMbFree;
  return typeof value === "number" ? value : fallback;
}

export async function transcriptionPaused(db: Db): Promise<boolean> {
  const [pause, settings] = await Promise.all([
    getAdminSettingValue<boolean>(db, "pause.transcription"),
    getAdminSettings(db),
  ]);
  return pause === true || settings.pauseAdmission;
}
