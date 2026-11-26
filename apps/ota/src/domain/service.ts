/**
 * OTA release service.
 *
 * Owns every rule the API contract states: manifests derived inside one
 * transaction, two retained builds per channel + binary, an expiry window for
 * builds that are not pushed again, the bundle size ceiling, and per-app push
 * tokens. Every query is scoped to one workspace, and the plan limits (apps,
 * bundle size, retention, monthly releases, own bucket) are enforced here.
 *
 * Correctness notes that are easy to get wrong:
 *
 * - The manifest is a query, never a written document, so a push cannot publish
 *   a half-written manifest.
 * - `ota_current` is a pointer per channel + binary rather than a `selected`
 *   flag on each row. A pointer is a single upsert with no competing unique
 *   index, so two simultaneous pushes cannot fail or corrupt each other; both
 *   rows survive and the last writer becomes current.
 * - A blob is uploaded before the pointer moves, and each build owns a key that
 *   contains its own release id. Readers therefore never see a manifest entry
 *   whose bytes are missing, and no two attempts ever write the same object.
 */

import { type ScopedDb, scoped } from "@templatedesign/app-shell/db/scoped";
import type { Db, Statement } from "@templatedesign/platform/db";
import { HttpError } from "@templatedesign/platform/http";
import {
  consume,
  entitlementLimit,
  refund,
  requireEntitlement,
  type Workspace,
} from "@templatedesign/platform/workspaces";
import {
  type AuditRow,
  auditFromRow,
  BUNDLE_CACHE_CONTROL,
  BUNDLE_CONTENT_TYPE,
  blobKey,
  bundleFile,
  CLEAR_SECRET,
  createToken,
  DEFAULT_RETENTION_DAYS,
  decodeCursor,
  encodeCursor,
  KEEP_PER_BINARY,
  newId,
  OtaError,
  type ReleaseRow,
  releaseFromRow,
  releaseIdFor,
  sha256Hex,
  timingSafeEqual,
  tokenPrefix,
} from "./data.js";
import { buildManifest } from "./manifest.js";
import { encryptSecret } from "./secrets.js";
import type {
  BlobRead,
  OtaActor,
  OtaApp,
  OtaAuditEvent,
  OtaBlobStore,
  OtaInfo,
  OtaManifest,
  OtaPlatform,
  OtaPushInput,
  OtaRelease,
  OtaReleasePage,
  OtaRetention,
  OtaStorageSettings,
  OtaStorageView,
  OtaTokenSummary,
} from "./types.js";
import { OTA_PLATFORMS } from "./types.js";
import {
  appSaveSchema,
  appSlugSchema,
  auditListSchema,
  idSchema,
  releaseListSchema,
  releaseMetadataSchema,
  retentionSettingSchema,
  storageSaveSchema,
  storageSettingsSchema,
  tokenCreateSchema,
} from "./validation.js";

const encoder = new TextEncoder();
const BYTES_PER_MB = 1024 * 1024;

function planLimitMessage(key: string, limit: number): string {
  switch (key) {
    case "apps":
      return `Your plan allows ${limit} app${limit === 1 ? "" : "s"}. Upgrade to add more.`;
    case "bundle.maxMb":
      return `Your plan allows bundles up to ${limit} MB. Upgrade to upload larger builds.`;
    case "releases.perMonth":
      return `Your plan allows ${limit} new release${limit === 1 ? "" : "s"} per month. It resets next month, or upgrade for more.`;
    case "retention.days":
      return `Your plan keeps builds for up to ${limit} days. Choose a shorter window or upgrade.`;
    case "s3.byo":
      return "Bringing your own S3 bucket is available on the Pro plan. Upgrade to use it.";
    default:
      return "Your plan limit is reached. Upgrade to continue.";
  }
}
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_USE_THROTTLE_MS = 60 * 1000;
/** Attempts allowed when two pushes reserve the same release id. */
const PUSH_ATTEMPTS = 5;
const PUSH_RETRY_MS = 25;

export const DEFAULT_STORAGE_SETTINGS: OtaStorageSettings = {
  mode: "platform",
  r2: { endpoint: "", bucket: "", accessKeyId: "", region: "auto", publicUrl: "", secret: "" },
  updatedAt: "",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** D1 reports a unique-index breach as a message match; there is no error code. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

export function storageView(
  settings: OtaStorageSettings,
  runtime: { platformAvailable: boolean; keyConfigured: boolean },
): OtaStorageView {
  return {
    mode: settings.mode,
    r2: {
      endpoint: settings.r2.endpoint,
      bucket: settings.r2.bucket,
      accessKeyId: settings.r2.accessKeyId,
      region: settings.r2.region,
      publicUrl: settings.r2.publicUrl,
      hasSecret: settings.r2.secret !== "",
    },
    platformAvailable: runtime.platformAvailable,
    keyConfigured: runtime.keyConfigured,
    updatedAt: settings.updatedAt === "" ? null : settings.updatedAt,
  };
}

export interface OtaServiceOptions {
  db: Db;
  /** The tenant this service acts for. Every query is scoped to `workspace.id`. */
  workspace: Pick<Workspace, "id" | "plan">;
  actor: OtaActor | null;
  /** Resolved lazily: admin actions that never touch storage must not require it. */
  blobs: () => Promise<OtaBlobStore>;
  now?: () => number;
  maxBundleBytes: number;
  /** Operator default for the retention window; a workspace setting and its plan can narrow it. */
  retentionDays?: number;
  baseUrl?: string;
  /** 32-byte key material for stored R2 secrets, or null when unset. */
  secretKey?: Uint8Array | null;
  /** Host storage availability, reported by the admin API. */
  platformAvailable?: boolean;
}

interface ReleaseKeyRow {
  id: string;
  file: string;
  app: string;
  platform: string;
  channel: string;
  binary: string;
}

interface Pair {
  app: string;
  platform: string;
  channel: string;
  binary: string;
}

export class OtaService {
  private readonly now: () => number;
  private readonly defaultRetentionDays: number;
  private readonly actor: OtaActor | null;
  private readonly as: ScopedDb;

  constructor(private readonly options: OtaServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.defaultRetentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.actor = options.actor;
    this.as = scoped(options.db, options.workspace.id);
  }

  // ---------------------------------------------------------------- queries

  private async first<T>(sql: string, args: unknown[]): Promise<T | null> {
    return this.as.first<T>(sql, args);
  }

  private async all<T>(sql: string, args: unknown[]): Promise<T[]> {
    return this.as.all<T>(sql, args);
  }

  private async run(sql: string, args: unknown[]): Promise<number> {
    return (await this.as.run(sql, args)).changes;
  }

  // ------------------------------------------------------------------ apps

  async listApps(): Promise<OtaApp[]> {
    const rows = await this.all<{
      slug: string;
      name: string;
      enabled: number;
      created_at: number;
      updated_at: number;
    }>("SELECT slug, name, enabled, created_at, updated_at FROM ota_apps WHERE workspace_id = :ws ORDER BY slug", []);
    return rows.map((row) => ({
      slug: row.slug,
      name: row.name,
      enabled: row.enabled === 1,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }

  async requireApp(slug: string): Promise<OtaApp> {
    const row = await this.first<{
      slug: string;
      name: string;
      enabled: number;
      created_at: number;
      updated_at: number;
    }>("SELECT slug, name, enabled, created_at, updated_at FROM ota_apps WHERE workspace_id = :ws AND slug = ?", [
      slug,
    ]);
    if (!row) throw new OtaError("APP_UNKNOWN", `No OTA app is registered as "${slug}".`, 404);
    const app: OtaApp = {
      slug: row.slug,
      name: row.name,
      enabled: row.enabled === 1,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
    if (!app.enabled) throw new OtaError("APP_DISABLED", `OTA pushes for "${slug}" are disabled.`, 409);
    return app;
  }

  async saveApp(input: unknown): Promise<OtaApp> {
    this.requireAdmin();
    const value = appSaveSchema.parse(input);
    const timestamp = this.now();
    const existing = await this.first<{ slug: string }>(
      "SELECT slug FROM ota_apps WHERE workspace_id = :ws AND slug = ?",
      [value.slug],
    );
    if (!existing) {
      // Only a new app counts against the plan; renaming or toggling an existing one never does.
      const count = await this.first<{ count: number }>(
        "SELECT COUNT(*) AS count FROM ota_apps WHERE workspace_id = :ws",
        [],
      );
      await this.enforce("apps", () =>
        requireEntitlement(this.options.db, this.options.workspace, "apps", { current: count?.count ?? 0 }),
      );
    }
    await this.run(
      `INSERT INTO ota_apps (workspace_id, slug, name, enabled, created_at, updated_at) VALUES (:ws, ?, ?, ?, ?, ?)
			 ON CONFLICT(workspace_id, slug) DO UPDATE SET name = excluded.name, enabled = excluded.enabled, updated_at = excluded.updated_at`,
      [value.slug, value.name, value.enabled ? 1 : 0, timestamp, timestamp],
    );
    await this.audit("app-save", { app: value.slug, detail: { enabled: value.enabled } });
    const apps = await this.listApps();
    const saved = apps.find((app) => app.slug === value.slug);
    if (!saved) throw new OtaError("INTERNAL_ERROR", "The app could not be saved.", 500);
    return saved;
  }

  // -------------------------------------------------------------- manifests

  /** Current build per channel + binary, resolved through the pointer table. */
  private async currentRows(app: string, platform: string, channel?: string, binary?: string): Promise<ReleaseRow[]> {
    const clauses = ["r.workspace_id = :ws", "r.app = ?", "r.platform = ?"];
    const args: unknown[] = [app, platform];
    if (channel !== undefined) {
      clauses.push("r.channel = ?");
      args.push(channel);
    }
    if (binary !== undefined) {
      clauses.push("r.binary = ?");
      args.push(binary);
    }
    return this.all<ReleaseRow>(
      `SELECT r.* FROM ota_releases r JOIN ota_current c ON c.workspace_id = r.workspace_id AND c.release_id = r.id
				 WHERE ${clauses.join(" AND ")} ORDER BY r.channel, r.binary`,
      args,
    );
  }

  async manifest(app: string, platform: OtaPlatform): Promise<OtaManifest> {
    await this.requireApp(app);
    const rows = await this.currentRows(app, platform);
    return buildManifest(rows.map((row) => releaseFromRow(row, true)));
  }

  async releases(app: string, platform: OtaPlatform, channel?: string, binary?: string): Promise<OtaRelease[]> {
    await this.requireApp(app);
    const rows = await this.currentRows(app, platform, channel, binary);
    return rows.map((row) => releaseFromRow(row, true));
  }

  /** Only files recorded in the database are ever served or deleted. */
  async findByFile(app: string, platform: OtaPlatform, file: string): Promise<OtaRelease | null> {
    const row = await this.first<ReleaseRow & { current: number }>(
      `SELECT r.*, CASE WHEN c.release_id IS NULL THEN 0 ELSE 1 END AS current
			 FROM ota_releases r LEFT JOIN ota_current c ON c.workspace_id = r.workspace_id AND c.release_id = r.id
				 WHERE r.workspace_id = :ws AND r.app = ? AND r.platform = ? AND r.file = ? LIMIT 1`,
      [app, platform, file],
    );
    return row ? releaseFromRow(row, row.current === 1) : null;
  }

  /** Resolve a recorded bundle and open it for reading. */
  async openBundle(
    app: string,
    platform: OtaPlatform,
    file: string,
    range?: { offset: number; length?: number },
  ): Promise<{ release: OtaRelease; read: BlobRead } | null> {
    const release = await this.findByFile(app, platform, file);
    if (!release) return null;
    const blobs = await this.options.blobs();
    const read = await blobs.get(blobKey(app, platform, file), range);
    if (!read)
      throw new OtaError(
        "BUNDLE_UNAVAILABLE",
        "The bundle is recorded but missing from storage. Push the build again.",
        404,
      );
    return { release, read };
  }

  /** Metadata-only read, used by `HEAD`. */
  async headBundle(
    app: string,
    platform: OtaPlatform,
    file: string,
  ): Promise<{ release: OtaRelease; size: number; contentType: string } | null> {
    const release = await this.findByFile(app, platform, file);
    if (!release) return null;
    const blobs = await this.options.blobs();
    const head = await blobs.head(blobKey(app, platform, file));
    if (!head)
      throw new OtaError(
        "BUNDLE_UNAVAILABLE",
        "The bundle is recorded but missing from storage. Push the build again.",
        404,
      );
    return { release, size: head.size, contentType: head.contentType };
  }

  /** Exposed for the admin storage probe and diagnostics. */
  async blobStore(): Promise<OtaBlobStore> {
    return this.options.blobs();
  }

  async listReleases(input: unknown): Promise<OtaReleasePage> {
    this.requireAdmin();
    const filter = releaseListSchema.parse(input);
    const clauses: string[] = ["r.workspace_id = :ws"];
    const args: unknown[] = [];
    if (filter.app) {
      clauses.push("r.app = ?");
      args.push(filter.app);
    }
    if (filter.platform) {
      clauses.push("r.platform = ?");
      args.push(filter.platform);
    }
    if (filter.channel) {
      clauses.push("r.channel = ?");
      args.push(filter.channel);
    }
    if (filter.binary) {
      clauses.push("r.binary = ?");
      args.push(filter.binary);
    }
    if (filter.cursor) {
      const cursor = decodeCursor(filter.cursor);
      if (cursor) {
        clauses.push("(r.created_at < ? OR (r.created_at = ? AND r.id < ?))");
        args.push(cursor.createdAt, cursor.createdAt, cursor.id);
      }
    }
    const where = `WHERE ${clauses.join(" AND ")}`;
    const rows = await this.all<ReleaseRow & { current: number }>(
      `SELECT r.*, CASE WHEN c.release_id IS NULL THEN 0 ELSE 1 END AS current
			 FROM ota_releases r LEFT JOIN ota_current c ON c.workspace_id = r.workspace_id AND c.release_id = r.id
				 ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
      [...args, filter.limit + 1],
    );
    const page = rows.slice(0, filter.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => releaseFromRow(row, row.current === 1)),
      nextCursor: rows.length > filter.limit && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  // ------------------------------------------------------------------ writes

  async push(app: string, platform: OtaPlatform, input: OtaPushInput): Promise<OtaRelease> {
    await this.requireApp(app);
    const metadata = releaseMetadataSchema.parse(input);
    if (input.bytes.byteLength === 0) throw new OtaError("BUNDLE_MISSING", "The bundle file is empty.", 400);
    if (input.bytes.byteLength > this.options.maxBundleBytes)
      throw new OtaError("BUNDLE_TOO_LARGE", "The uploaded bundle is too large.", 413);
    await this.enforce("bundle.maxMb", () =>
      requireEntitlement(this.options.db, this.options.workspace, "bundle.maxMb", {
        need: Math.ceil(input.bytes.byteLength / BYTES_PER_MB),
        current: 0,
      }),
    );

    const actual = await sha256Hex(input.bytes);
    if (!timingSafeEqual(actual, input.sha256))
      throw new OtaError(
        "SHA_MISMATCH",
        `The uploaded bundle does not match the declared sha256. Server computed ${actual}.`,
        400,
      );

    const pair: Pair = { app, platform, channel: input.channel, binary: input.binary };
    const current = await this.currentRows(app, platform, input.channel, input.binary);
    const existing = current[0];
    if (
      existing &&
      existing.sha256 === input.sha256 &&
      existing.size === input.bytes.byteLength &&
      existing.signature === metadata.signature &&
      (existing.mandatory === 1) === metadata.mandatory
    ) {
      // Retry only when both bundle bytes and mobile update metadata match.
      await this.audit("push-replay", { app, platform, channel: input.channel, binary: input.binary });
      return releaseFromRow(existing, true);
    }

    const blobs = await this.options.blobs();
    // One release against the monthly allowance. A replay above never reaches this point, and the
    // unit is handed back if the build is not stored.
    await this.enforce("releases.perMonth", () =>
      consume(this.options.db, this.options.workspace, "releases.perMonth"),
    );
    try {
      return await this.storeRelease(pair, input, metadata, blobs);
    } catch (error) {
      await refund(this.options.db, this.options.workspace, "releases.perMonth").catch(() => undefined);
      throw error;
    }
  }

  private async storeRelease(
    pair: Pair,
    input: OtaPushInput,
    metadata: { signature: string; mandatory: boolean },
    blobs: OtaBlobStore,
  ): Promise<OtaRelease> {
    const { app, platform } = pair;
    let reserved: ReleaseRow | null = null;

    // Reserve the identity first: the unique index on
    // (app, platform, channel, binary, release_id) decides the winner, so no
    // two attempts ever upload to the same object key.
    for (let attempt = 0; attempt < PUSH_ATTEMPTS && reserved === null; attempt += 1) {
      const createdAt = this.now() + attempt * 1000;
      const releaseId = releaseIdFor(createdAt);
      const candidate: ReleaseRow = {
        id: newId(),
        app,
        platform,
        channel: input.channel,
        binary: input.binary,
        release_id: releaseId,
        file: bundleFile(input.channel, input.binary, releaseId),
        sha256: input.sha256,
        size: input.bytes.byteLength,
        note: input.note,
        commit_sha: input.commit,
        signature: metadata.signature,
        mandatory: metadata.mandatory ? 1 : 0,
        branch: input.channel,
        created_at: createdAt,
      };
      try {
        await this.run(
          `INSERT INTO ota_releases (workspace_id, id, app, platform, channel, binary, release_id, file, sha256, size, note, commit_sha, signature, mandatory, branch, created_at)
						 VALUES (:ws, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            candidate.id,
            candidate.app,
            candidate.platform,
            candidate.channel,
            candidate.binary,
            candidate.release_id,
            candidate.file,
            candidate.sha256,
            candidate.size,
            candidate.note,
            candidate.commit_sha,
            candidate.signature,
            candidate.mandatory,
            candidate.branch,
            candidate.created_at,
          ],
        );
        reserved = candidate;
      } catch (error) {
        if (!isUniqueViolation(error) || attempt === PUSH_ATTEMPTS - 1) {
          console.error("[ota] release reserve failed", {
            errorType: error instanceof Error ? error.name : "unknown",
          });
          throw new OtaError("PUSH_FAILED", "The release could not be recorded. Retry the push.", 500);
        }
        await sleep(PUSH_RETRY_MS * (attempt + 1));
      }
    }
    if (!reserved) throw new OtaError("PUSH_FAILED", "The release could not be recorded. Retry the push.", 500);
    const release = reserved;

    try {
      await blobs.put(blobKey(app, platform, release.file), input.bytes, {
        contentType: BUNDLE_CONTENT_TYPE,
        cacheControl: BUNDLE_CACHE_CONTROL,
      });
    } catch (error) {
      await this.run("DELETE FROM ota_releases WHERE workspace_id = :ws AND id = ?", [release.id]).catch(
        () => undefined,
      );
      if (error instanceof OtaError) throw error;
      throw new OtaError("STORAGE_FAILED", "The bundle could not be uploaded. Retry the push.", 502);
    }

    // The build becomes visible only once its bytes are stored.
    await this.movePointer(pair, release.id);
    await this.prune(pair);
    await this.purgeExpired().catch(() => undefined);
    await this.audit("push", {
      app,
      platform,
      channel: input.channel,
      binary: input.binary,
      detail: {
        releaseId: release.release_id,
        size: release.size,
        sha256: release.sha256,
        backend: blobs.describe(),
      },
    });
    return releaseFromRow(release, true);
  }

  async deleteChannel(app: string, platform: OtaPlatform, channel: string, binary: string): Promise<number> {
    await this.requireApp(app);
    const rows = await this.all<ReleaseKeyRow>(
      "SELECT id, file, app, platform, channel, binary FROM ota_releases WHERE workspace_id = :ws AND app = ? AND platform = ? AND channel = ? AND binary = ?",
      [app, platform, channel, binary],
    );
    await this.run(
      "DELETE FROM ota_current WHERE workspace_id = :ws AND app = ? AND platform = ? AND channel = ? AND binary = ?",
      [app, platform, channel, binary],
    );
    await this.deleteRows(rows);
    await this.audit("release-remove", { app, platform, channel, binary, detail: { releases: rows.length } });
    return rows.length;
  }

  async deleteRelease(input: unknown): Promise<{ deleted: number }> {
    this.requireAdmin();
    const { id } = idSchema.parse(input);
    const row = await this.first<ReleaseRow>("SELECT * FROM ota_releases WHERE workspace_id = :ws AND id = ?", [id]);
    if (!row) throw new OtaError("RELEASE_NOT_FOUND", "That release no longer exists.", 404);
    const release = releaseFromRow(row, false);
    await this.deleteRows([
      { id: row.id, file: row.file, app: row.app, platform: row.platform, channel: row.channel, binary: row.binary },
    ]);
    await this.audit("release-delete", {
      app: release.app,
      platform: release.platform,
      channel: release.channel,
      binary: release.binary,
      detail: { releaseId: release.releaseId },
    });
    return { deleted: 1 };
  }

  /** Roll a channel + binary back: the chosen build becomes the manifest entry. */
  async promoteRelease(input: unknown): Promise<OtaRelease> {
    this.requireAdmin();
    const { id } = idSchema.parse(input);
    const row = await this.first<ReleaseRow>("SELECT * FROM ota_releases WHERE workspace_id = :ws AND id = ?", [id]);
    if (!row) throw new OtaError("RELEASE_NOT_FOUND", "That release no longer exists.", 404);
    const pair: Pair = { app: row.app, platform: row.platform, channel: row.channel, binary: row.binary };
    await this.movePointer(pair, row.id);
    await this.prune(pair);
    const release = releaseFromRow(row, true);
    await this.audit("release-promote", {
      app: release.app,
      platform: release.platform,
      channel: release.channel,
      binary: release.binary,
      detail: { releaseId: release.releaseId },
    });
    return release;
  }

  // --------------------------------------------------------------- retention

  private async movePointer(pair: Pair, releaseRowId: string): Promise<void> {
    await this.run(
      `INSERT INTO ota_current (workspace_id, app, platform, channel, binary, release_id, updated_at) VALUES (:ws, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(workspace_id, app, platform, channel, binary) DO UPDATE SET release_id = excluded.release_id, updated_at = excluded.updated_at`,
      [pair.app, pair.platform, pair.channel, pair.binary, releaseRowId, this.now()],
    );
  }

  /**
   * Drop a pointer whose build is gone, and otherwise point at the newest
   * remaining build.
   */
  private async restorePointer(pair: Pair): Promise<void> {
    const args = [pair.app, pair.platform, pair.channel, pair.binary];
    await this.run(
      `INSERT OR IGNORE INTO ota_current (workspace_id, app, platform, channel, binary, release_id, updated_at)
				 SELECT :ws, ?, ?, ?, ?, id, ? FROM ota_releases WHERE workspace_id = :ws AND app = ? AND platform = ? AND channel = ? AND binary = ?
				 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [...args, this.now(), ...args],
    );
  }

  /** Keep the current build plus the newest other build for a channel + binary. */
  private async prune(pair: Pair): Promise<void> {
    const rows = await this.all<ReleaseKeyRow>(
      `SELECT r.id, r.file, r.app, r.platform, r.channel, r.binary FROM ota_releases r
			 LEFT JOIN ota_current c ON c.workspace_id = r.workspace_id AND c.release_id = r.id
				 WHERE r.workspace_id = :ws AND r.app = ? AND r.platform = ? AND r.channel = ? AND r.binary = ?
			 ORDER BY (c.release_id IS NOT NULL) DESC, r.created_at DESC, r.id DESC`,
      [pair.app, pair.platform, pair.channel, pair.binary],
    );
    const excess = rows.slice(KEEP_PER_BINARY);
    if (excess.length === 0) return;
    await this.deleteRows(excess);
  }

  /** Remove builds that have not been pushed again inside the retention window. */
  async purgeExpired(): Promise<number> {
    const cutoff = this.now() - (await this.retentionDays()) * DAY_MS;
    let removed = 0;
    // Bounded batches: one push must not hold the request open on a large backlog.
    for (let round = 0; round < 5; round += 1) {
      const rows = await this.all<ReleaseKeyRow>(
        `SELECT id, file, app, platform, channel, binary FROM ota_releases
				 WHERE workspace_id = :ws AND created_at < ? ORDER BY created_at ASC LIMIT 200`,
        [cutoff],
      );
      if (rows.length === 0) break;
      await this.deleteRows(rows);
      removed += rows.length;
      if (rows.length < 200) break;
    }
    if (removed > 0)
      await this.audit("release-expire", {
        detail: { releases: removed, cutoff: new Date(cutoff).toISOString() },
      });
    return removed;
  }

  private async deleteRows(rows: readonly ReleaseKeyRow[]): Promise<void> {
    if (rows.length === 0) return;
    const pairs = new Map<string, { pair: Pair; ids: string[] }>();
    for (const row of rows) {
      const key = `${row.app}\u0000${row.platform}\u0000${row.channel}\u0000${row.binary}`;
      const entry = pairs.get(key) ?? {
        pair: { app: row.app, platform: row.platform, channel: row.channel, binary: row.binary },
        ids: [],
      };
      entry.ids.push(row.id);
      pairs.set(key, entry);
    }

    // Detaching the pointer is part of the same atomic batch as the delete:
    // `ota_current.release_id` references `ota_releases.id`, so the pointer must
    // be cleared before the row it targets disappears.
    const detach: Statement[] = [...pairs.values()].map(({ pair, ids }) => ({
      sql: `DELETE FROM ota_current WHERE workspace_id = :ws AND app = ? AND platform = ? AND channel = ? AND binary = ?
					 AND release_id IN (${ids.map(() => "?").join(", ")})`,
      params: [pair.app, pair.platform, pair.channel, pair.binary, ...ids],
    }));
    const deletes: Statement[] = rows.map((row) => ({
      sql: "DELETE FROM ota_releases WHERE workspace_id = :ws AND id = ?",
      params: [row.id],
    }));
    await this.as.batch([...detach, ...deletes]);

    // Deleting an object twice is harmless, so a concurrent delete of the same row needs no special case.
    const blobs = await this.options.blobs();
    for (const row of rows) {
      try {
        await blobs.delete(blobKey(row.app, row.platform, row.file));
      } catch (error) {
        // The row is gone, so a stuck object is invisible but still billed;
        // log it for the operator instead of failing the committed request.
        console.error("[ota] object cleanup failed", {
          errorType: error instanceof Error ? error.name : "unknown",
        });
      }
    }
    for (const { pair } of pairs.values()) await this.restorePointer(pair).catch(() => undefined);
  }

  // ----------------------------------------------------------------- tokens

  async listTokens(app?: string): Promise<OtaTokenSummary[]> {
    this.requireAdmin();
    const rows = await this.all<{
      id: string;
      app: string;
      name: string;
      token_prefix: string;
      created_at: number;
      last_used_at: number | null;
      revoked_at: number | null;
    }>(
      `SELECT id, app, name, token_prefix, created_at, last_used_at, revoked_at FROM ota_tokens
				 WHERE workspace_id = :ws ${app ? "AND app = ?" : ""} ORDER BY created_at DESC LIMIT 200`,
      app ? [app] : [],
    );
    return rows.map((row) => ({
      id: row.id,
      app: row.app,
      name: row.name,
      prefix: row.token_prefix,
      createdAt: new Date(row.created_at).toISOString(),
      lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at).toISOString(),
      revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
    }));
  }

  async createToken(input: unknown): Promise<{ token: string; record: OtaTokenSummary }> {
    this.requireAdmin();
    const value = tokenCreateSchema.parse(input);
    await this.requireApp(value.app);
    const token = createToken();
    const id = newId();
    const createdAt = this.now();
    await this.run(
      "INSERT INTO ota_tokens (workspace_id, id, app, name, token_hash, token_prefix, created_at, last_used_at, revoked_at) VALUES (:ws, ?, ?, ?, ?, ?, ?, NULL, NULL)",
      [id, value.app, value.name, await sha256Hex(encoder.encode(token)), tokenPrefix(token), createdAt],
    );
    await this.audit("token-create", { app: value.app, detail: { name: value.name, prefix: tokenPrefix(token) } });
    return {
      token,
      record: {
        id,
        app: value.app,
        name: value.name,
        prefix: tokenPrefix(token),
        createdAt: new Date(createdAt).toISOString(),
        lastUsedAt: null,
        revokedAt: null,
      },
    };
  }

  async revokeToken(input: unknown): Promise<{ revoked: boolean }> {
    this.requireAdmin();
    const { id } = idSchema.parse(input);
    const changes = await this.run(
      "UPDATE ota_tokens SET revoked_at = ? WHERE workspace_id = :ws AND id = ? AND revoked_at IS NULL",
      [this.now(), id],
    );
    if (changes === 0) throw new OtaError("TOKEN_NOT_FOUND", "That token is unknown or already revoked.", 404);
    await this.audit("token-revoke", { detail: { id } });
    return { revoked: true };
  }

  /**
   * Authenticate a push. The token must exist, be active, and belong to the app
   * in the URL: a valid token for one app must never write to another.
   */
  async authenticatePush(app: string, header: string | null): Promise<void> {
    const token = readBearer(header);
    if (!token) throw new OtaError("AUTH_REQUIRED", "A bearer push token is required.", 401);
    const hash = await sha256Hex(encoder.encode(token));
    const row = await this.first<{ id: string; app: string; token_hash: string; revoked_at: number | null }>(
      "SELECT id, app, token_hash, revoked_at FROM ota_tokens WHERE workspace_id = :ws AND token_hash = ?",
      [hash],
    );
    if (!row || !timingSafeEqual(row.token_hash, hash))
      throw new OtaError("TOKEN_INVALID", "The push token is not valid.", 401);
    if (row.revoked_at !== null) throw new OtaError("TOKEN_REVOKED", "This push token has been revoked.", 401);
    if (row.app !== app)
      throw new OtaError("TOKEN_APP_MISMATCH", `This push token is not valid for app "${app}".`, 403);
    const timestamp = this.now();
    await this.run(
      "UPDATE ota_tokens SET last_used_at = ? WHERE workspace_id = :ws AND id = ? AND (last_used_at IS NULL OR last_used_at < ?)",
      [timestamp, row.id, timestamp - TOKEN_USE_THROTTLE_MS],
    ).catch(() => undefined);
  }

  // ------------------------------------------------------------ upload keys

  private async uploadKeyRecord(app: string): Promise<{ hash: string; updatedAt: number } | null> {
    const row = await this.first<{ value: string; updated_at: number }>(
      "SELECT value, updated_at FROM ota_settings WHERE workspace_id = :ws AND key = ?",
      [`upload-key:${app}`],
    );
    if (!row) return null;
    const value: unknown = JSON.parse(row.value);
    if (
      typeof value !== "object" ||
      value === null ||
      !("hash" in value) ||
      typeof value.hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.hash)
    )
      throw new OtaError("INVALID_CONFIGURATION", "The upload key configuration is invalid.", 500);
    return { hash: value.hash, updatedAt: row.updated_at };
  }

  async getUploadKey(app: string): Promise<{ app: string; configured: boolean; updatedAt: string | null }> {
    this.requireAdmin();
    appSlugSchema.parse(app);
    await this.requireApp(app);
    const record = await this.uploadKeyRecord(app);
    return {
      app,
      configured: record !== null,
      updatedAt: record === null ? null : new Date(record.updatedAt).toISOString(),
    };
  }

  /** First creation enables protection; every subsequent creation replaces the key. */
  async rotateUploadKey(input: unknown): Promise<{
    key: string;
    record: { app: string; configured: boolean; updatedAt: string };
  }> {
    this.requireAdmin();
    const app = appSlugSchema.parse(
      typeof input === "object" && input !== null && "app" in input ? input.app : undefined,
    );
    await this.requireApp(app);
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(64))));
    const timestamp = this.now();
    await this.run(
      `INSERT INTO ota_settings (workspace_id, key, value, version, updated_at) VALUES (:ws, ?, ?, 1, ?)
				 ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value, version = ota_settings.version + 1, updated_at = excluded.updated_at`,
      [`upload-key:${app}`, JSON.stringify({ hash: await sha256Hex(encoder.encode(key)) }), timestamp],
    );
    await this.audit("upload-key-rotate", { app });
    return { key, record: { app, configured: true, updatedAt: new Date(timestamp).toISOString() } };
  }

  async authenticateUploadKey(app: string, key: string | null): Promise<void> {
    const record = await this.uploadKeyRecord(app);
    if (record === null) return;
    if (!key) throw new OtaError("UPLOAD_KEY_REQUIRED", "An X-OTA-Upload-Key header is required for this app.", 403);
    if (key.length !== 88 || !timingSafeEqual(record.hash, await sha256Hex(encoder.encode(key))))
      throw new OtaError("UPLOAD_KEY_INVALID", "The upload key is not valid for this app.", 403);
  }

  // --------------------------------------------------------------- settings

  async getStorageSettings(): Promise<OtaStorageSettings> {
    const row = await this.first<{ value: string }>(
      "SELECT value FROM ota_settings WHERE workspace_id = :ws AND key = 'storage'",
      [],
    );
    if (!row) return { ...DEFAULT_STORAGE_SETTINGS };
    try {
      const parsed = storageSettingsSchema.safeParse(JSON.parse(row.value));
      if (!parsed.success) return { ...DEFAULT_STORAGE_SETTINGS };
      return { ...DEFAULT_STORAGE_SETTINGS, ...parsed.data };
    } catch {
      return { ...DEFAULT_STORAGE_SETTINGS };
    }
  }

  async saveStorageSettings(input: unknown): Promise<OtaStorageView> {
    this.requireAdmin();
    const value = storageSaveSchema.parse(input);
    if (value.mode === "r2") await this.requireByoStorage();

    const existing = await this.getStorageSettings();
    let secret = existing.r2.secret;
    if (value.r2.secret !== "") {
      if (value.r2.secret === CLEAR_SECRET) secret = "";
      else {
        if (!this.options.secretKey)
          throw new OtaError(
            "SECRET_KEY_MISSING",
            "OTA_SECRET_KEY is not configured on this host, so an R2 secret cannot be stored. Generate one, set it as a host secret, then save again.",
            400,
          );
        secret = await encryptSecret(value.r2.secret, this.options.secretKey);
      }
    }
    if (value.mode === "r2" && secret === "")
      throw new OtaError("STORAGE_NOT_CONFIGURED", "A secret access key is required for a private R2 bucket.", 400);

    const settings: OtaStorageSettings = {
      mode: value.mode,
      r2: {
        endpoint: value.r2.endpoint,
        bucket: value.r2.bucket,
        accessKeyId: value.r2.accessKeyId,
        region: value.r2.region === "" ? "auto" : value.r2.region,
        publicUrl: value.r2.publicUrl,
        secret,
      },
      updatedAt: new Date(this.now()).toISOString(),
    };
    await this.run(
      `INSERT INTO ota_settings (workspace_id, key, value, version, updated_at) VALUES (:ws, 'storage', ?, 1, ?)
				 ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value, version = ota_settings.version + 1, updated_at = excluded.updated_at`,
      [JSON.stringify(settings), this.now()],
    );
    await this.audit("storage-save", {
      detail: { mode: settings.mode, bucket: settings.r2.bucket, endpoint: settings.r2.endpoint },
    });
    return storageView(settings, {
      platformAvailable: this.options.platformAvailable ?? false,
      keyConfigured: Boolean(this.options.secretKey),
    });
  }

  // ------------------------------------------------------------------- info

  async info(storage: OtaStorageView): Promise<OtaInfo> {
    this.requireAdmin();
    const totals = await this.first<{ releases: number; channels: number; bytes: number }>(
      "SELECT COUNT(*) AS releases, COUNT(DISTINCT channel) AS channels, COALESCE(SUM(size), 0) AS bytes FROM ota_releases WHERE workspace_id = :ws",
      [],
    );
    const tokens = await this.first<{ tokens: number }>(
      "SELECT COUNT(*) AS tokens FROM ota_tokens WHERE workspace_id = :ws AND revoked_at IS NULL",
      [],
    );
    return {
      apps: await this.listApps(),
      platforms: OTA_PLATFORMS,
      storage,
      counts: {
        releases: totals?.releases ?? 0,
        channels: totals?.channels ?? 0,
        bytes: totals?.bytes ?? 0,
        tokens: tokens?.tokens ?? 0,
      },
      limits: {
        maxBundleBytes: this.options.maxBundleBytes,
        retentionDays: await this.retentionDays(),
        keepPerBinary: KEEP_PER_BINARY,
      },
      baseUrl: this.options.baseUrl ?? "",
    };
  }

  async listAudit(input: unknown): Promise<OtaAuditEvent[]> {
    this.requireAdmin();
    const { limit } = auditListSchema.parse(input);
    const rows = await this.all<AuditRow>(
      `SELECT id, action, actor_id, actor_kind, app, platform, channel, binary, detail_json, created_at
			 FROM ota_audit WHERE workspace_id = :ws ORDER BY created_at DESC, id DESC LIMIT ?`,
      [limit],
    );
    return rows.map(auditFromRow);
  }

  // ------------------------------------------------------------- retention window

  private async storedRetentionDays(): Promise<number | null> {
    const row = await this.first<{ value: string }>(
      "SELECT value FROM ota_settings WHERE workspace_id = :ws AND key = 'retention'",
      [],
    );
    if (!row) return null;
    try {
      const parsed = retentionSettingSchema.safeParse(JSON.parse(row.value));
      return parsed.success ? parsed.data.days : null;
    } catch {
      return null;
    }
  }

  /**
   * Days a build is kept. The workspace's own choice wins and stays in force after a downgrade, so a
   * plan change never removes data on its own; without a choice the operator default applies,
   * narrowed to what the plan allows.
   */
  async retentionDays(): Promise<number> {
    const stored = await this.storedRetentionDays();
    if (stored !== null) return stored;
    const limit = await entitlementLimit(this.options.db, this.options.workspace, "retention.days");
    return limit > 0 && this.defaultRetentionDays > limit ? limit : this.defaultRetentionDays;
  }

  async getRetention(): Promise<OtaRetention> {
    this.requireAdmin();
    return {
      days: await this.retentionDays(),
      planLimit: await entitlementLimit(this.options.db, this.options.workspace, "retention.days"),
      custom: (await this.storedRetentionDays()) !== null,
    };
  }

  async saveRetention(input: unknown): Promise<OtaRetention> {
    this.requireAdmin();
    const { days } = retentionSettingSchema.parse(input);
    await this.enforce("retention.days", () =>
      requireEntitlement(this.options.db, this.options.workspace, "retention.days", { need: days, current: 0 }),
    );
    await this.run(
      `INSERT INTO ota_settings (workspace_id, key, value, version, updated_at) VALUES (:ws, 'retention', ?, 1, ?)
			 ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value, version = ota_settings.version + 1, updated_at = excluded.updated_at`,
      [JSON.stringify({ days }), this.now()],
    );
    await this.audit("retention-save", { detail: { days } });
    return this.getRetention();
  }

  // ---------------------------------------------------------------- internal

  /** Bring-your-own S3 bucket is a paid-plan feature. */
  async requireByoStorage(): Promise<void> {
    await this.enforce("s3.byo", () => requireEntitlement(this.options.db, this.options.workspace, "s3.byo"));
  }

  /** Turn the platform's generic quota error into a message that names the plan limit. */
  private async enforce(key: string, check: () => Promise<unknown>): Promise<void> {
    try {
      await check();
    } catch (error) {
      if (error instanceof HttpError && error.code === "quota_exceeded") {
        const limit = typeof error.details?.limit === "number" ? error.details.limit : 0;
        throw new OtaError("PLAN_LIMIT", planLimitMessage(key, limit), 402);
      }
      throw error;
    }
  }

  private requireAdmin(): void {
    if (!this.actor?.administrator) throw new OtaError("FORBIDDEN", "An administrator account is required.", 403);
  }

  private async audit(
    action: string,
    context: {
      app?: string;
      platform?: string;
      channel?: string;
      binary?: string;
      detail?: Record<string, unknown>;
    },
  ): Promise<void> {
    try {
      await this.run(
        `INSERT INTO ota_audit (workspace_id, id, actor_id, actor_kind, action, app, platform, channel, binary, detail_json, created_at)
					 VALUES (:ws, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(),
          this.actor?.id ?? null,
          this.actor ? "administrator" : "push-token",
          action,
          context.app ?? null,
          context.platform ?? null,
          context.channel ?? null,
          context.binary ?? null,
          JSON.stringify(context.detail ?? {}),
          this.now(),
        ],
      );
    } catch (error) {
      console.error("[ota] audit write failed", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}

export function readBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
