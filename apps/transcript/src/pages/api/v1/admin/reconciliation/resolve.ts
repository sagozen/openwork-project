import { auditAdmin, requireAdmin } from "@templatedesign/platform/admin";
import { d1Db, nowIso } from "@templatedesign/platform/db";
import { HttpError, handleApi, json, readJson } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../../../lib/runtime";

/** Mark a reconciliation finding resolved. A reason is mandatory and audited. */
export const POST: APIRoute = async ({ locals, request }) =>
  handleApi(request, async () => {
    const db = d1Db(runtimeEnv().DB);
    const actor = await requireAdmin(db, locals.user, runtimeEnv(), "admin");
    const body = await readJson<{ finding_id: string; reason: string }>(request);
    const reason = body.reason?.trim();
    if (!reason) throw new HttpError("invalid_input", 400, "A reason is required.");
    const finding = await db.first<{ id: string; kind: string }>(
      "SELECT id, kind FROM reconciliation_findings WHERE id = ?",
      [body.finding_id ?? ""],
    );
    if (!finding) throw new HttpError("not_found", 404, "Finding not found.");
    await db.run("UPDATE reconciliation_findings SET resolved_at = ? WHERE id = ?", [nowIso(), finding.id]);
    await auditAdmin(db, actor, "admin.reconciliation.resolve", "reconciliation", finding.id, reason, {
      kind: finding.kind,
    });
    return json({ resolved: true });
  });
