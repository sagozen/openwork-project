import type { CrmHooks, CrmProductUsage } from "@templatedesign/platform/config";
import { rank } from "@templatedesign/platform/crm";
import type { Db } from "@templatedesign/platform/db";

/** TranscriptAnything's side of the shared mini CRM: its first success and its usage numbers. */
async function usage(db: Db, fromMs: number, toMs: number): Promise<CrmProductUsage> {
  const range = [new Date(fromMs).toISOString(), new Date(toMs).toISOString()];
  const [jobs, bySource, topErrors] = await Promise.all([
    db.first<{
      total: number;
      ok: number | null;
      failed: number | null;
      guests: number | null;
      api: number | null;
      minutes: number | null;
      credits: number | null;
      tenants: number;
    }>(
      `SELECT COUNT(*) AS total, SUM(status = 'succeeded') AS ok, SUM(status = 'failed') AS failed,
         SUM(tenant_id IS NULL) AS guests, SUM(via_api = 1) AS api,
         SUM(billable_minutes) AS minutes, SUM(charged_credits) AS credits,
         COUNT(DISTINCT tenant_id) AS tenants
       FROM transcription_jobs WHERE created_at >= ? AND created_at < ?`,
      range,
    ),
    db.all<{ label: string; count: number }>(
      `SELECT source_kind AS label, COUNT(*) AS count FROM transcription_jobs
       WHERE created_at >= ? AND created_at < ? GROUP BY source_kind ORDER BY count DESC LIMIT 5`,
      range,
    ),
    db.all<{ label: string; count: number }>(
      `SELECT error_code AS label, COUNT(*) AS count FROM transcription_jobs
       WHERE status = 'failed' AND error_code IS NOT NULL AND created_at >= ? AND created_at < ?
       GROUP BY error_code ORDER BY count DESC LIMIT 5`,
      range,
    ),
  ]);
  const total = jobs?.total ?? 0;
  const ok = jobs?.ok ?? 0;
  const failed = jobs?.failed ?? 0;
  const guests = jobs?.guests ?? 0;
  const api = jobs?.api ?? 0;
  const minutes = jobs?.minutes ?? 0;
  const credits = jobs?.credits ?? 0;
  const tenants = jobs?.tenants ?? 0;
  return {
    headline: `${total} lượt phiên âm`,
    lines: [
      `Lượt phiên âm: ${total} (thành công ${ok}, lỗi ${failed}).`,
      `Số phút đã tính: ${minutes}. Credit đã dùng: ${credits}.`,
      `Khách có tài khoản đang dùng: ${tenants}. Khách vãng lai: ${guests}. Qua API: ${api}.`,
      `Nguồn: ${rank(bySource)}.`,
      ...(topErrors.length ? [`Mã lỗi: ${rank(topErrors)}.`] : []),
    ],
    cards: [
      { value: String(total), label: `Transcriptions (${ok} ok, ${failed} failed)` },
      { value: String(tenants), label: `Active accounts · ${guests} guest jobs` },
      { value: String(minutes), label: `Minutes · ${credits} credits` },
    ],
  };
}

export const transcriptCrm: CrmHooks = {
  firstSuccessSql: `SELECT tenant_id, NULL, 'first_success', '', json_object('source', source_kind), created_at FROM (
    SELECT tenant_id, source_kind, created_at,
      ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS rn
    FROM transcription_jobs WHERE status = 'succeeded' AND tenant_id IS NOT NULL) WHERE rn = 1`,
  usage,
};
