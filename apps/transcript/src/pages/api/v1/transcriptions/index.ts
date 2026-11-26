import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi, json, readJson } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { actorOwnsJob, resolveActor, verifyTurnstile } from "../../../../lib/api";
import { assertNotBlocked, countJobsCreated, requestAbuseSubjects } from "../../../../lib/job-abuse";
import {
  cancelJob,
  confirmJob,
  createJob,
  getJob,
  type JobRow,
  listJobs,
  mapJob,
  withCaptionDefault,
} from "../../../../lib/jobs";
import { type JobOptions, PRICING } from "../../../../lib/pricing";
import { runtimeEnv } from "../../../../lib/runtime";
import { classifyUrl } from "../../../../lib/sources";
import { isHumanCookie, markHuman, turnstileRequired } from "../../../../lib/turnstile";
import { completeUpload } from "../../../../lib/uploads";

interface CreateBody {
  link?: unknown;
  upload_id?: unknown;
  probe_id?: unknown;
  options?: unknown;
  confirm_above?: unknown;
  items?: unknown;
  language?: unknown;
}

function parseOptions(input: unknown, fallback: JobOptions = {}): JobOptions {
  if (!input || typeof input !== "object") return fallback;
  const raw = input as Record<string, unknown>;
  const options: JobOptions = { ...fallback };
  if (typeof raw.language === "string") options.language = raw.language.slice(0, 12);
  if (typeof raw.word_timestamps === "boolean") options.word_timestamps = raw.word_timestamps;
  if (typeof raw.use_creator_captions === "boolean") options.use_creator_captions = raw.use_creator_captions;
  if (raw.summary === null) options.summary = null;
  if (raw.summary && typeof raw.summary === "object") {
    const summary = raw.summary as Record<string, unknown>;
    const preset = String(summary.preset ?? "");
    if (["short", "bullets", "chapters", "qa", "filter"].includes(preset)) {
      options.summary = {
        preset: preset as "short" | "bullets" | "chapters" | "qa" | "filter",
        instruction: typeof summary.instruction === "string" ? summary.instruction.slice(0, 500) : undefined,
        language: typeof summary.language === "string" ? summary.language.slice(0, 12) : undefined,
      };
      if (options.summary.preset === "filter" && !options.summary.instruction) {
        throw new HttpError("invalid_input", 400, "A filter needs an instruction.", { field: "summary.instruction" });
      }
    }
  }
  return options;
}

function confirmAbove(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

/**
 * `POST /api/v1/transcriptions` accepts four shapes, all of which end in a queued job:
 * a link, an upload id, a probed preview id (confirm) or a checklist of items (batch).
 * `GET` lists the tenant's or the guest's transcriptions.
 */
export const POST: APIRoute = async (context) => {
  const { locals, request } = context;
  return handleApi(request, async () => {
    const env = runtimeEnv();
    const db = d1Db(env.DB);
    const body = await readJson<CreateBody>(request);
    const actor = await resolveActor(locals, request, "transcriptions:write");
    const subjects = requestAbuseSubjects(actor, request);
    await assertNotBlocked(db, subjects);
    // Guests must pass one human check per 15 minutes: either a fresh Turnstile token or the
    // cookie minted by the preview that already verified them.
    if (!actor.tenantId && turnstileRequired(env) && !isHumanCookie(context)) {
      await verifyTurnstile(
        env,
        (body as { turnstile_token?: unknown }).turnstile_token,
        request.headers.get("cf-connecting-ip"),
      );
      markHuman(context);
    }
    const options = parseOptions(body.options, {
      language: typeof body.language === "string" ? body.language : undefined,
    });
    const idempotencyKey = request.headers.get("idempotency-key");
    const threshold = confirmAbove(body.confirm_above);

    if (!actor.tenantId && (options.word_timestamps || options.summary)) {
      throw new HttpError("unauthenticated", 401, "Sign in to use add-ons.", { reason: "sign_in_required" });
    }

    // 1) Confirm a preview/probe the user already saw a price for. No new job: the probe was
    // counted against the abuse threshold when the preview created it.
    if (typeof body.probe_id === "string") {
      const job = await getJob(db, body.probe_id);
      if (!job || !actorOwnsJob(actor, job)) throw new HttpError("not_found", 404, "Preview not found.");
      if (!["preview_ready", "awaiting_confirmation"].includes(job.status)) {
        throw new HttpError("invalid_input", 409, "That preview is no longer open.", { status: job.status });
      }
      const confirmOptions = withCaptionDefault(options, job.source_kind);
      await db.run("UPDATE transcription_jobs SET options_json = ?, updated_at = ? WHERE id = ?", [
        JSON.stringify(confirmOptions),
        new Date().toISOString(),
        job.id,
      ]);
      const confirmed = await confirmJob(
        env,
        db,
        { ...job, options_json: JSON.stringify(confirmOptions), preview: 0 },
        threshold,
      );
      return json({ transcription: mapJob(confirmed) }, { status: 201 });
    }

    // 2) Batch: one request, one idempotency key, one queue entry per item.
    if (Array.isArray(body.items)) {
      const items = body.items
        .filter((item): item is { url: string; title?: string; duration_seconds?: number } =>
          Boolean(item && typeof item === "object" && typeof (item as { url?: unknown }).url === "string"),
        )
        .slice(0, PRICING.maxLinksPerBatch);
      if (items.length === 0) throw new HttpError("invalid_input", 400, "Select at least one item.");
      const batchId = `bat_${crypto.randomUUID().replaceAll("-", "")}`;
      const created: JobRow[] = [];
      let fresh = 0;
      try {
        for (const item of items) {
          const source = classifyUrl(item.url);
          const { job, reused } = await createJob(env, db, {
            tenantId: actor.tenantId,
            guestId: actor.guestId,
            userId: actor.userId,
            viaApi: actor.viaApi,
            source,
            options,
            title: item.title ?? null,
            durationSeconds: typeof item.duration_seconds === "number" ? item.duration_seconds : null,
            idempotencyKey: idempotencyKey ? `${idempotencyKey}:${created.length}` : null,
            batchId,
            confirmAbove: threshold,
          });
          created.push(job);
          if (!reused) fresh += 1;
        }
      } catch (error) {
        for (const job of created) await cancelJob(env, db, job).catch(() => undefined);
        throw error;
      }
      await countJobsCreated(env, db, subjects, fresh);
      const total = created.reduce((sum, job) => sum + (job.reserved_credits ?? 0), 0);
      return json({ transcriptions: created.map(mapJob), batch_id: batchId, total_credits: total }, { status: 201 });
    }

    // 3) A file the browser already uploaded straight to R2.
    if (typeof body.upload_id === "string") {
      const upload = await completeUpload(env, db, body.upload_id, {
        tenantId: actor.tenantId,
        guestId: actor.guestId,
      });
      const { job, reused } = await createJob(env, db, {
        tenantId: actor.tenantId,
        guestId: actor.guestId,
        userId: actor.userId,
        viaApi: actor.viaApi,
        source: {
          kind: "upload",
          ref: upload.r2_key,
          url: upload.r2_key,
          host: "",
          multi: null,
          ytdlp: false,
          label: "upload",
        },
        options,
        title: upload.filename,
        idempotencyKey,
        confirmAbove: threshold,
      });
      if (!reused) await countJobsCreated(env, db, subjects, 1);
      return json({ transcription: mapJob(job) }, { status: 201 });
    }

    // 4) A pasted link.
    if (typeof body.link !== "string" || body.link.trim().length === 0) {
      throw new HttpError("invalid_input", 400, "Provide a link, an upload or a probe id.");
    }
    const source = classifyUrl(body.link);
    const { job, reused } = await createJob(env, db, {
      tenantId: actor.tenantId,
      guestId: actor.guestId,
      userId: actor.userId,
      viaApi: actor.viaApi,
      source,
      options,
      idempotencyKey,
      confirmAbove: threshold,
    });
    if (!reused) await countJobsCreated(env, db, subjects, 1);
    return json({ transcription: mapJob(job), reused }, { status: reused ? 200 : 201 });
  });
};

export const GET: APIRoute = async ({ locals, request }) =>
  handleApi(request, async () => {
    const actor = await resolveActor(locals, request, "transcriptions:read");
    const jobs = await listJobs(d1Db(runtimeEnv().DB), {
      tenantId: actor.tenantId,
      guestId: actor.guestId,
    });
    return json({ data: jobs.map(mapJob) });
  });
