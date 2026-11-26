import { requireAdmin } from "@templatedesign/platform/admin";
import { d1Db } from "@templatedesign/platform/db";
import { HttpError, handleApi, json, readJson } from "@templatedesign/platform/http";
import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../../../../lib/runtime";
import {
  compareVersions,
  createWorkerRelease,
  listWorkerReleases,
  maxReleaseBytes,
  releaseKey,
  validReleaseTarget,
  validReleaseVersion,
  type WorkerReleaseRow,
} from "../../../../../../lib/worker-releases";

/** Admin-only worker release registry. The binary itself is uploaded straight to R2. */
export const GET: APIRoute = async ({ locals, request }) =>
  handleApi(request, async () => {
    const env = runtimeEnv();
    const db = d1Db(env.DB);
    await requireAdmin(db, locals.user, env, "support");
    return json({ data: await listWorkerReleases(db) });
  });

export const POST: APIRoute = async ({ locals, request }) =>
  handleApi(request, async () => {
    const env = runtimeEnv();
    const db = d1Db(env.DB);
    const actor = await requireAdmin(db, locals.user, env, "admin");
    const body = await readJson<{
      version?: string;
      platform?: string;
      arch?: string;
      key?: string;
      sha256?: string;
      sizeBytes?: number;
      notes?: string;
    }>(request);

    const version = (body.version ?? "").trim();
    const platform = (body.platform ?? "windows").trim();
    const arch = (body.arch ?? "amd64").trim();
    if (!validReleaseVersion(version)) {
      throw new HttpError("invalid_input", 400, "Version must look like 1.9.0 or 1.9.0-beta.");
    }
    if (!validReleaseTarget(platform, arch)) {
      throw new HttpError("invalid_input", 400, "Unsupported platform/arch.");
    }
    const expectedKey = releaseKey(version, platform, arch);
    // Never accept an arbitrary object key: the outputs bucket also holds user transcripts.
    if (body.key !== expectedKey) {
      throw new HttpError("invalid_input", 400, "The upload key does not match this release.");
    }
    const sha256 = (body.sha256 ?? "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new HttpError("invalid_input", 400, "sha256 must be 64 hex characters.");
    }
    const sizeBytes = Number(body.sizeBytes ?? 0);
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > maxReleaseBytes()) {
      throw new HttpError("invalid_input", 400, "The executable must be between 1 byte and 200 MB.");
    }
    const object = await env.OUTPUTS.head(expectedKey);
    if (!object) {
      throw new HttpError("invalid_input", 400, "Upload the executable before publishing the release.");
    }
    if (Number(object.size) !== sizeBytes) {
      throw new HttpError("invalid_input", 400, "The uploaded object size does not match the executable.");
    }
    const existing = await db.first<{ id: string }>(
      "SELECT id FROM worker_releases WHERE version = ? AND platform = ? AND arch = ?",
      [version, platform, arch],
    );
    if (existing) throw new HttpError("revision_conflict", 409, "That version already exists for this platform.");

    const latest = (await listWorkerReleases(db, 100)).find(
      (release: WorkerReleaseRow) => release.platform === platform && release.arch === arch && release.active === 1,
    );
    if (latest && compareVersions(version, latest.version) <= 0) {
      throw new HttpError("invalid_input", 400, `Version must be newer than the active ${latest.version}.`);
    }

    const release = await createWorkerRelease(db, {
      version,
      platform,
      arch,
      objectKey: expectedKey,
      sha256,
      sizeBytes,
      notes: body.notes,
      actorId: actor.userId,
    });
    const { auditAdmin } = await import("@templatedesign/platform/admin");
    await auditAdmin(db, actor, "admin.worker.release_published", "worker_release", release.id, null, {
      version,
      platform,
      arch,
      sha256,
    });
    return json({ release }, { status: 201 });
  });
