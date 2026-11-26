import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi, json, readJson } from "@templatedesign/platform/http";
import { takeRateLimit } from "@templatedesign/platform/rate-limit";
import type { APIRoute } from "astro";
import { resolveActor, verifyTurnstile } from "../../../../lib/api";
import { assertNotBlocked, countJobsCreated, countRateLimited, requestAbuseSubjects } from "../../../../lib/job-abuse";
import { createJob } from "../../../../lib/jobs";
import { runtimeEnv } from "../../../../lib/runtime";
import { type ClassifiedSource, classifyUrl, oembedEndpoint } from "../../../../lib/sources";
import { isHumanCookie, markHuman, turnstileRequired } from "../../../../lib/turnstile";

interface PreviewItem {
  url: string;
  job_id: string | null;
  kind: string | null;
  title: string | null;
  thumbnail: string | null;
  multi: "playlist" | "folder" | null;
  status: "probing" | "unsupported";
  error: string | null;
}

async function oembed(source: ClassifiedSource): Promise<{ title?: string; thumbnail?: string }> {
  const endpoint = oembedEndpoint(source);
  if (!endpoint) return {};
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return {};
    const body = (await response.json()) as { title?: string; thumbnail_url?: string };
    return { title: body.title, thumbnail: body.thumbnail_url };
  } catch {
    return {};
  }
}

/**
 * Fast link preview: oEmbed answers title and thumbnail within a second, and a `probe` job
 * supplies duration, playlist items and the exact price (the UI polls the job).
 */
export const POST: APIRoute = async (context) => {
  const { locals, request } = context;
  return handleApi(request, async () => {
    const env = runtimeEnv();
    const db = d1Db(env.DB);
    const body = await readJson<{ url?: unknown; urls?: unknown; turnstile_token?: unknown; language?: unknown }>(
      request,
    );
    const list = Array.isArray(body.urls)
      ? body.urls.filter((value): value is string => typeof value === "string")
      : typeof body.url === "string"
        ? [body.url]
        : [];
    if (list.length === 0) throw new HttpError("invalid_input", 400, "Paste a link first.");
    if (list.length > 50) throw new HttpError("invalid_input", 400, "At most 50 links per request.");

    const actor = await resolveActor(locals, request, "transcriptions:write");
    const subjects = requestAbuseSubjects(actor, request);
    await assertNotBlocked(db, subjects);
    if (!actor.tenantId && turnstileRequired(env) && !isHumanCookie(context)) {
      await verifyTurnstile(env, body.turnstile_token, request.headers.get("cf-connecting-ip"));
      markHuman(context);
    }
    const limit = actor.tenantId ? 240 : 60;
    await countRateLimited(env, db, subjects, () =>
      takeRateLimit(
        db,
        `preview:${actor.tenantId ?? actor.guestId}`,
        limit,
        3600,
        (retry) => `Too many previews. Try again in ${Math.ceil(retry / 60)} minutes.`,
      ),
    );

    const items: PreviewItem[] = [];
    for (const raw of list) {
      try {
        const source = classifyUrl(raw);
        const [meta, created] = await Promise.all([
          oembed(source),
          createJob(env, db, {
            tenantId: actor.tenantId,
            guestId: actor.guestId,
            userId: actor.userId,
            viaApi: actor.viaApi,
            source,
            options: { language: typeof body.language === "string" ? body.language : undefined },
            title: null,
            preview: true,
          }),
        ]);
        items.push({
          url: raw,
          job_id: created.job.id,
          kind: source.kind,
          title: meta.title ?? null,
          thumbnail: meta.thumbnail ?? null,
          multi: source.multi,
          status: "probing",
          error: null,
        });
      } catch (error) {
        const details = error instanceof HttpError ? (error.details as { reason?: string } | undefined) : undefined;
        items.push({
          url: raw,
          job_id: null,
          kind: null,
          title: null,
          thumbnail: null,
          multi: null,
          status: "unsupported",
          error: details?.reason ?? (error instanceof HttpError ? error.code : "unsupported"),
        });
      }
    }
    const probed = items.filter((item) => item.job_id).length;
    // Each probe is a job a worker runs, so it counts against the hourly job threshold.
    await countJobsCreated(env, db, subjects, probed);
    return json({ items, probed });
  });
};
