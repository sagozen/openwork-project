import { z } from "zod";
import type {
  Locale,
  MediaAsset,
  MediaRouteState,
  RouteReadiness,
  VideoProvider,
} from "../model.js";
import { all, type CourseOutline, type DomainCollection } from "../service.js";
import {
  DomainError,
  idSchema,
  link,
  readRecord,
  text,
} from "../validation.js";

export const localeSchema = z.enum(["vi", "en", "es"]);
const providerSchema = z.enum(["doverunner", "wistia"]);
const roleSchema = z.enum(["original", "dub"]);
// DoveRunner CID rule; it must equal the CID used when packaging.
const contentIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
// Wistia hashed IDs are short lowercase alphanumerics (10 in current samples).
const wistiaIdSchema = z.string().regex(/^[a-z0-9]{6,32}$/);
const timestamp = z.number().int().min(0).max(8_640_000_000_000_000);
export const assetIdSchema = z.string().regex(/^[a-f0-9]{32}$/);

const routeSchema = z.strictObject({
  packageRef: z.string().max(200).nullable(),
  manifests: z.strictObject({
    dash: link.nullable(),
    hls: link.nullable(),
  }),
  smokeTestedAt: timestamp.nullable(),
  captionsVerified: z.boolean(),
  status: z.enum(["pending", "ready", "failed"]),
});
export const storedAssetSchema = z.strictObject({
  schemaVersion: z.literal(1),
  siteId: z.string().max(253),
  courseId: idSchema,
  lessonId: idSchema,
  locale: localeSchema,
  mediaRevision: z.number().int().min(1),
  provider: providerSchema,
  contentId: z.union([z.literal(""), contentIdSchema]),
  role: roleSchema,
  wistia: z
    .strictObject({
      mediaHashedId: wistiaIdSchema,
      localizationId: z.string().max(64).nullable(),
    })
    .nullable(),
  durationSeconds: z.number().int().min(0).max(86_400),
  state: z.enum(["draft", "verified", "published", "retired"]),
  routes: z.strictObject({ primary: routeSchema, backup: routeSchema }),
  securityPolicyVersion: z.string().max(64),
  note: text(500),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type StoredAsset = z.infer<typeof storedAssetSchema>;

const assetInputSchema = z
  .strictObject({
    courseId: idSchema,
    lessonId: idSchema,
    locale: localeSchema,
    role: roleSchema,
    provider: providerSchema,
    contentId: z.string().max(200),
    dashUrl: link,
    hlsUrl: link,
    wistiaMediaHashedId: z.string().max(32),
    durationSeconds: z.number().int().min(0).max(86_400),
  })
  .superRefine((value, ctx) => {
    const wistia =
      value.wistiaMediaHashedId === "" ||
      wistiaIdSchema.safeParse(value.wistiaMediaHashedId).success;
    if (!wistia)
      ctx.addIssue({
        code: "custom",
        path: ["wistiaMediaHashedId"],
        message: "Use the Wistia media ID from the media page URL.",
      });
    if (value.provider === "doverunner") {
      if (!contentIdSchema.safeParse(value.contentId).success)
        ctx.addIssue({
          code: "custom",
          path: ["contentId"],
          message: "Use the DoveRunner content ID used for packaging.",
        });
      if (!value.dashUrl && !value.hlsUrl)
        ctx.addIssue({
          code: "custom",
          path: ["dashUrl"],
          message: "Add a DASH and/or HLS manifest URL.",
        });
    } else if (
      !value.wistiaMediaHashedId ||
      value.contentId ||
      value.dashUrl ||
      value.hlsUrl
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["wistiaMediaHashedId"],
        message: "Wistia playback needs only the Wistia media ID.",
      });
    }
  });
export const mediaAssetsSchema = z.strictObject({ courseId: idSchema });
export const saveMediaAssetSchema = z.strictObject({
  id: assetIdSchema,
  revision: z.string().min(1).max(512).nullable(),
  value: assetInputSchema,
});
export const mediaTransitionSchema = z.strictObject({
  mediaAssetId: assetIdSchema,
  revision: z.string().min(1).max(512),
  to: z.enum(["draft", "verified", "published", "retired"]),
  note: z.string().trim().pipe(text(500)),
});
export const mediaRouteSchema = z.strictObject({
  to: z.enum(["primary", "backup", "paused"]),
  reason: z
    .string()
    .trim()
    .pipe(text(500))
    .refine((value) => value.length > 0),
});
const storedRouteStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  active: z.enum(["primary", "backup", "paused"]),
  reason: text(500),
  changedAt: timestamp,
});

const liveSchema = z.strictObject({
  schemaVersion: z.literal(1),
  courseId: idSchema,
  lessonId: idSchema,
  locale: localeSchema,
  mediaAssetId: assetIdSchema.nullable(),
  updatedAt: timestamp,
});
type Live = z.infer<typeof liveSchema>;
async function liveKey(courseId: string, lessonId: string, locale: Locale) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([courseId, lessonId, locale])),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
const LOCALE_ORDER: Locale[] = ["vi", "en", "es"];

export const SECURITY_POLICY: Record<VideoProvider, string> = {
  doverunner: "doverunner-streaming-v1",
  wistia: "wistia-enrollment-gated-v1",
};
const ROUTE_STATE_KEY = "site";
const iso = (value: number | null) =>
  value === null ? null : new Date(value).toISOString();

export function assetView(
  id: string,
  revision: string,
  value: StoredAsset,
): MediaAsset {
  const route = (readiness: StoredAsset["routes"]["primary"]) =>
    ({
      ...readiness,
      smokeTestedAt: iso(readiness.smokeTestedAt),
    }) satisfies RouteReadiness;
  return {
    id,
    revision,
    courseId: value.courseId,
    lessonId: value.lessonId,
    locale: value.locale,
    mediaRevision: value.mediaRevision,
    provider: value.provider,
    contentId: value.contentId,
    role: value.role,
    wistia: value.wistia,
    durationSeconds: value.durationSeconds,
    state: value.state,
    routes: {
      primary: route(value.routes.primary),
      backup: route(value.routes.backup),
    },
    securityPolicyVersion: value.securityPolicyVersion,
    note: value.note,
    createdAt: iso(value.createdAt)!,
    updatedAt: iso(value.updatedAt)!,
  };
}

export interface MediaCatalogStorage {
  mediaAssets: DomainCollection;
  mediaRouteState: DomainCollection;
  /** One live pointer per course, lesson and language. */
  mediaLive: DomainCollection;
}
/** Which providers the site currently allows students to play. */
export type EnabledProviders = Record<VideoProvider, boolean>;

export class MediaCatalog {
  constructor(
    private readonly storage: MediaCatalogStorage,
    private readonly outline: (
      courseId: string,
    ) => Promise<CourseOutline | null>,
    private readonly now: () => number = Date.now,
  ) {}

  async assets(courseId: string): Promise<MediaAsset[]> {
    const assets: MediaAsset[] = [];
    for (const row of await all(this.storage.mediaAssets, { courseId })) {
      const record = await this.storage.mediaAssets.getVersioned(row.id);
      if (!record) continue;
      const value = readRecord(storedAssetSchema, record.value);
      if (value.courseId === courseId)
        assets.push(assetView(row.id, record.revision, value));
    }
    return assets.sort(
      (a, b) =>
        a.lessonId.localeCompare(b.lessonId) ||
        a.locale.localeCompare(b.locale) ||
        b.mediaRevision - a.mediaRevision,
    );
  }

  async save(
    input: z.infer<typeof saveMediaAssetSchema>,
    siteId: string,
  ): Promise<MediaAsset> {
    const { id, revision, value } = input;
    const outline = await this.outline(value.courseId);
    if (!outline) throw new DomainError("NOT_FOUND", "Course not found.");
    if (!outline.lessons.some((lesson) => lesson.id === value.lessonId))
      throw new DomainError("NOT_FOUND", "Lesson not found.");
    const previous = await this.storage.mediaAssets.getVersioned(id);
    const existing = previous
      ? readRecord(storedAssetSchema, previous.value)
      : null;
    if ((previous?.revision ?? null) !== revision)
      throw new DomainError(
        "CONFLICT",
        "This video changed. Reload before saving.",
      );
    if (existing?.state === "published")
      throw new DomainError(
        "PUBLISHED_LOCKED",
        "Published videos cannot be edited. Add a new video for this lesson and publish it to replace this one.",
      );
    if (
      existing &&
      (existing.courseId !== value.courseId ||
        existing.lessonId !== value.lessonId)
    )
      throw new DomainError(
        "CONFLICT",
        "A video cannot move to another lesson. Add a new video instead.",
      );
    let mediaRevision = existing?.mediaRevision ?? 1;
    if (!existing)
      for (const row of await all(this.storage.mediaAssets, {
        lessonId: value.lessonId,
      })) {
        const other = readRecord(storedAssetSchema, row.data);
        if (
          other.courseId === value.courseId &&
          other.locale === value.locale &&
          other.role === value.role
        )
          mediaRevision = Math.max(mediaRevision, other.mediaRevision + 1);
      }
    const now = this.now();
    const drm = value.provider === "doverunner";
    const stored: StoredAsset = {
      schemaVersion: 1,
      siteId,
      courseId: value.courseId,
      lessonId: value.lessonId,
      locale: value.locale,
      mediaRevision,
      provider: value.provider,
      contentId: drm ? value.contentId : "",
      role: value.role,
      wistia: value.wistiaMediaHashedId
        ? { mediaHashedId: value.wistiaMediaHashedId, localizationId: null }
        : null,
      durationSeconds: value.durationSeconds,
      // Any edit invalidates the previous device check.
      state: "draft",
      routes: {
        primary: {
          packageRef: drm ? value.contentId : value.wistiaMediaHashedId,
          manifests: drm
            ? { dash: value.dashUrl || null, hls: value.hlsUrl || null }
            : { dash: null, hls: null },
          smokeTestedAt: null,
          captionsVerified: false,
          status: "pending",
        },
        backup: {
          packageRef: null,
          manifests: { dash: null, hls: null },
          smokeTestedAt: null,
          captionsVerified: false,
          status: "pending",
        },
      },
      securityPolicyVersion: SECURITY_POLICY[value.provider],
      note: existing?.note ?? "",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const saved = await this.storage.mediaAssets.compareAndSet(
      id,
      revision,
      stored,
    );
    if (!saved.applied)
      throw new DomainError(
        "CONFLICT",
        "This video changed. Reload before saving.",
      );
    return assetView(id, saved.revision, stored);
  }

  async transition(
    input: z.infer<typeof mediaTransitionSchema>,
  ): Promise<MediaAsset> {
    const record = await this.storage.mediaAssets.getVersioned(
      input.mediaAssetId,
    );
    if (!record) throw new DomainError("NOT_FOUND", "Video not found.");
    if (record.revision !== input.revision)
      throw new DomainError(
        "CONFLICT",
        "This video changed. Reload before continuing.",
      );
    const value = readRecord(storedAssetSchema, record.value);
    const allowed: Record<StoredAsset["state"], StoredAsset["state"][]> = {
      draft: ["verified", "retired"],
      verified: ["published", "draft", "retired"],
      published: ["retired"],
      retired: ["draft"],
    };
    if (!allowed[value.state].includes(input.to))
      throw new DomainError(
        "NOT_READY",
        `A ${value.state} video cannot move to ${input.to}.`,
      );
    const primary = value.routes.primary;
    const source =
      value.provider === "wistia"
        ? Boolean(value.wistia)
        : Boolean(primary.manifests.dash || primary.manifests.hls);
    if (input.to === "verified" && !source)
      throw new DomainError("NOT_READY", "Add the video source first.");
    if (input.to === "published") {
      if (primary.status !== "ready" || primary.smokeTestedAt === null)
        throw new DomainError(
          "NOT_READY",
          "Play the video on a real device and mark it verified before publishing.",
        );
      const outline = await this.outline(value.courseId);
      if (!outline?.lessons.some((lesson) => lesson.id === value.lessonId))
        throw new DomainError(
          "NOT_READY",
          "This lesson no longer exists in the course.",
        );
    }
    const key = await liveKey(value.courseId, value.lessonId, value.locale);
    const isLive =
      (await this.readLive(key))?.value.mediaAssetId === input.mediaAssetId;
    if (input.to === "retired" && isLive) await this.guardLastVideo(value);
    const now = this.now();
    const next: StoredAsset = {
      ...value,
      state: input.to,
      note: input.note,
      updatedAt: now,
      routes: {
        ...value.routes,
        primary:
          input.to === "verified"
            ? { ...primary, smokeTestedAt: now, status: "ready" }
            : input.to === "draft"
              ? { ...primary, smokeTestedAt: null, status: "pending" }
              : primary,
      },
    };
    // Publishing moves the live pointer first: a video counts as live only when
    // the pointer names it AND it is published, so a crash in between serves
    // nothing new rather than two videos.
    const previous =
      input.to === "published"
        ? await this.point(key, value, input.mediaAssetId)
        : undefined;
    const saved = await this.storage.mediaAssets.compareAndSet(
      input.mediaAssetId,
      input.revision,
      next,
    );
    if (!saved.applied) {
      if (input.to === "published")
        await this.point(key, value, previous ?? null, input.mediaAssetId);
      throw new DomainError(
        "CONFLICT",
        "This video changed. Reload before continuing.",
      );
    }
    if (input.to === "published" && previous && previous !== input.mediaAssetId)
      await this.retire(previous, "Replaced by a newer published video.");
    if (input.to === "retired" && isLive)
      await this.point(key, value, null, input.mediaAssetId);
    return assetView(input.mediaAssetId, saved.revision, next);
  }

  /** Retiring the only video of a lesson with no notes would leave students an empty lesson. */
  private async guardLastVideo(value: StoredAsset) {
    const outline = await this.outline(value.courseId);
    const lesson = outline?.lessons.find((item) => item.id === value.lessonId);
    if (!outline?.published || !lesson || lesson.standalone) return;
    const others = (
      await this.liveAssets(value.lessonId, value.courseId)
    ).filter((asset) => asset.value.locale !== value.locale);
    if (!others.length)
      throw new DomainError(
        "NOT_READY",
        "This lesson has no notes or direct video. Publish a replacement video or add lesson notes before retiring this one.",
      );
  }

  private async readLive(key: string) {
    const record = await this.storage.mediaLive.getVersioned(key);
    if (!record) return null;
    const parsed = liveSchema.safeParse(record.value);
    return parsed.success
      ? { revision: record.revision, value: parsed.data }
      : null;
  }

  /**
   * Compare-and-set the live pointer. Returns the previously live asset ID.
   * With `expected`, only moves the pointer while it still names that asset.
   */
  private async point(
    key: string,
    asset: StoredAsset,
    mediaAssetId: string | null,
    expected?: string,
  ): Promise<string | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const record = await this.storage.mediaLive.getVersioned(key);
      const current = record ? liveSchema.safeParse(record.value) : null;
      const previous = current?.success ? current.data.mediaAssetId : null;
      if (expected !== undefined && previous !== expected) return previous;
      const value: Live = {
        schemaVersion: 1,
        courseId: asset.courseId,
        lessonId: asset.lessonId,
        locale: asset.locale,
        mediaAssetId,
        updatedAt: this.now(),
      };
      const saved = await this.storage.mediaLive.compareAndSet(
        key,
        record?.revision ?? null,
        value,
      );
      if (saved.applied) return previous;
    }
    throw new DomainError(
      "CONFLICT",
      "Another change to this lesson's video is in progress. Reload and try again.",
    );
  }

  private async retire(id: string, note: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const record = await this.storage.mediaAssets.getVersioned(id);
      const parsed = record ? storedAssetSchema.safeParse(record.value) : null;
      if (!record || !parsed?.success || parsed.data.state !== "published")
        return;
      const saved = await this.storage.mediaAssets.compareAndSet(
        id,
        record.revision,
        { ...parsed.data, state: "retired", note, updatedAt: this.now() },
      );
      if (saved.applied) return;
    }
  }

  /** Live, published assets of a lesson. Malformed rows are skipped, never fatal to students. */
  private async liveAssets(lessonId: string, courseId: string) {
    const live: { id: string; value: StoredAsset }[] = [];
    for (const row of await all(this.storage.mediaLive, { lessonId })) {
      const pointer = liveSchema.safeParse(row.data);
      if (
        !pointer.success ||
        pointer.data.courseId !== courseId ||
        !pointer.data.mediaAssetId
      )
        continue;
      const record = await this.storage.mediaAssets.getVersioned(
        pointer.data.mediaAssetId,
      );
      const asset = record ? storedAssetSchema.safeParse(record.value) : null;
      if (
        asset?.success &&
        asset.data.state === "published" &&
        asset.data.courseId === courseId &&
        asset.data.lessonId === lessonId &&
        asset.data.locale === pointer.data.locale
      )
        live.push({ id: pointer.data.mediaAssetId, value: asset.data });
    }
    return live.sort(
      (a, b) =>
        LOCALE_ORDER.indexOf(a.value.locale) -
        LOCALE_ORDER.indexOf(b.value.locale),
    );
  }

  /** Course of a video, for staff scope checks. */
  async courseOf(mediaAssetId: string): Promise<string | null> {
    const record = await this.storage.mediaAssets.getVersioned(mediaAssetId);
    const parsed = record ? storedAssetSchema.safeParse(record.value) : null;
    return parsed?.success ? parsed.data.courseId : null;
  }

  async routeState(): Promise<MediaRouteState> {
    const record =
      await this.storage.mediaRouteState.getVersioned(ROUTE_STATE_KEY);
    if (!record) return { active: "primary", reason: "", changedAt: null };
    const value = readRecord(storedRouteStateSchema, record.value);
    return {
      active: value.active,
      reason: value.reason,
      changedAt: iso(value.changedAt),
    };
  }

  async setRoute(
    input: z.infer<typeof mediaRouteSchema>,
  ): Promise<MediaRouteState> {
    // No backup delivery route is provisioned; refuse rather than pretend.
    if (input.to === "backup")
      throw new DomainError(
        "BACKUP_NOT_READY",
        "No backup delivery route is ready for this site.",
      );
    const now = this.now();
    await this.storage.mediaRouteState.put(ROUTE_STATE_KEY, {
      schemaVersion: 1,
      active: input.to,
      reason: input.reason,
      changedAt: now,
    });
    return { active: input.to, reason: input.reason, changedAt: iso(now) };
  }

  /** The live video for a lesson: the requested language, else the original, else any live one. */
  async select(
    courseId: string,
    lessonId: string,
    locale: Locale,
    enabled: EnabledProviders,
  ): Promise<{ id: string; value: StoredAsset } | null> {
    const live = (await this.liveAssets(lessonId, courseId)).filter(
      (asset) => enabled[asset.value.provider],
    );
    return (
      live.find((asset) => asset.value.locale === locale) ??
      live.find((asset) => asset.value.role === "original") ??
      live[0] ??
      null
    );
  }

  async playableLessons(
    courseId: string,
    lessonIds: string[],
    enabled: EnabledProviders,
  ): Promise<string[]> {
    if (!enabled.doverunner && !enabled.wistia) return [];
    const wanted = new Set(lessonIds);
    const playable = new Set<string>();
    for (const row of await all(this.storage.mediaLive, { courseId })) {
      const pointer = liveSchema.safeParse(row.data);
      if (
        !pointer.success ||
        !pointer.data.mediaAssetId ||
        !wanted.has(pointer.data.lessonId) ||
        playable.has(pointer.data.lessonId)
      )
        continue;
      const record = await this.storage.mediaAssets.getVersioned(
        pointer.data.mediaAssetId,
      );
      const asset = record ? storedAssetSchema.safeParse(record.value) : null;
      if (
        asset?.success &&
        asset.data.state === "published" &&
        asset.data.courseId === courseId &&
        asset.data.lessonId === pointer.data.lessonId &&
        enabled[asset.data.provider]
      )
        playable.add(pointer.data.lessonId);
    }
    return lessonIds.filter((id) => playable.has(id));
  }
}
