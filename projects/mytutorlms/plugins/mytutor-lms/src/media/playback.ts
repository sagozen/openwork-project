import { z } from "zod";
import type { PlaybackDeviceSession, PlaybackGrant } from "../model.js";
import type { DomainCollection, LmsService } from "../service.js";
import { DomainError, idSchema, readRecord, text } from "../validation.js";
import {
  localeSchema,
  SECURITY_POLICY,
  type EnabledProviders,
  type MediaCatalog,
} from "./catalog.js";
import {
  fairPlayCertificateUrl,
  LICENSE_TOKEN_HEADER,
  LICENSE_URL,
  mintLicenseToken,
  streamingPolicy,
  TOKEN_VALIDITY_SECONDS,
  type DoveRunnerCredentials,
} from "./doverunner.js";

const MINUTE = 60 * 1000;
const sessionIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.number().int().min(0).max(8_640_000_000_000_000);

export const playbackSchema = z.strictObject({
  courseId: idSchema,
  lessonId: idSchema,
  locale: localeSchema,
  drm: z.enum(["widevine", "playready", "fairplay"]).nullable(),
  deviceLabel: z.string().trim().pipe(text(60)),
  replaceSessionId: sessionIdSchema.nullable(),
});
export const playbackEndSchema = z.strictObject({ sessionId: sessionIdSchema });

// Append-mostly ledger: one row per issued playback session.
const storedSessionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  siteId: z.string().max(253),
  studentRef: z.string().regex(/^[a-f0-9]{32}$/),
  studentId: z.string().regex(/^[a-f0-9]{64}$/),
  enrollmentId: z.string().regex(/^[a-f0-9]{64}$/),
  courseId: idSchema,
  lessonId: idSchema,
  courseRevision: z.string().max(512),
  mediaAssetId: z.string().max(64),
  provider: z.enum(["doverunner", "wistia"]),
  contentId: z.string().max(200),
  locale: localeSchema,
  route: z.literal("primary"),
  // Forensic watermark sessions need the CDN embedder; none is issued yet.
  watermarkSessionId: z.string().max(200).nullable(),
  drmPolicyVersion: z.string().max(64),
  deviceLabel: text(60),
  issuedAt: timestamp,
  notAfter: timestamp,
  endedAt: timestamp.nullable(),
  endReason: z.enum(["ended", "replaced", "revoked", "expired"]).nullable(),
  previousSessionId: sessionIdSchema.nullable(),
});
type StoredSession = z.infer<typeof storedSessionSchema>;
type EndReason = NonNullable<StoredSession["endReason"]>;

// One record per enrollment holding its open sessions. Every start and end is a
// compare-and-set on this record, so parallel requests cannot exceed the limit.
const slotEntrySchema = z.strictObject({
  id: sessionIdSchema,
  deviceLabel: text(60),
  issuedAt: timestamp,
  notAfter: timestamp,
});
const slotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessions: z.array(slotEntrySchema).max(20),
});
type SlotEntry = z.infer<typeof slotEntrySchema>;

export interface MediaSettings {
  enabled: EnabledProviders;
  doverunner: DoveRunnerCredentials | null;
  /** Ask DoveRunner to enforce the screen limit too (needs CSL enabled in Console). */
  concurrentStreamLimit: boolean;
  deviceLimit: number;
  licenseWindowMinutes: number;
  /** Per-site secret for the opaque learner reference sent to vendors. */
  studentRefKey: string;
}
export interface PlaybackStorage {
  playbackSessions: DomainCollection;
  playbackSlots: DomainCollection;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
function secret(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
}
/** HMAC so a guessed course and email cannot be confirmed against vendor logs. */
async function studentRef(key: string, enrollmentId: string): Promise<string> {
  const hmac = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    await crypto.subtle.sign(
      "HMAC",
      hmac,
      new TextEncoder().encode(enrollmentId),
    ),
  ).slice(0, 32);
}

/** `issueVideoPlayback`: the only way a learner obtains video playback. */
export class PlaybackService {
  constructor(
    private readonly storage: PlaybackStorage,
    private readonly catalog: MediaCatalog,
    private readonly lms: LmsService,
    private readonly settings: MediaSettings,
    private readonly now: () => number = Date.now,
  ) {}

  private async slot(enrollmentId: string) {
    const record = await this.storage.playbackSlots.getVersioned(enrollmentId);
    const now = this.now();
    const sessions = record
      ? readRecord(slotSchema, record.value).sessions.filter(
          (session) => session.notAfter > now,
        )
      : [];
    return { revision: record?.revision ?? null, sessions };
  }

  /** Atomically claim a screen, optionally replacing one of the learner's own sessions. */
  private async claim(
    enrollmentId: string,
    entry: SlotEntry,
    replaceSessionId: string | null,
  ): Promise<string | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const slot = await this.slot(enrollmentId);
      const replaced = slot.sessions.find(
        (session) => session.id === replaceSessionId,
      );
      const others = slot.sessions.filter((session) => session !== replaced);
      if (others.length >= this.settings.deviceLimit)
        throw new DomainError(
          "DEVICE_LIMIT",
          "Video is already playing on another screen.",
          {
            sessions: others.map(
              (session): PlaybackDeviceSession => ({
                id: session.id,
                deviceLabel: session.deviceLabel,
                issuedAt: new Date(session.issuedAt).toISOString(),
              }),
            ),
          },
        );
      const saved = await this.storage.playbackSlots.compareAndSet(
        enrollmentId,
        slot.revision,
        { schemaVersion: 1, sessions: [...others, entry] },
      );
      if (saved.applied) return replaced?.id ?? null;
    }
    throw new DomainError(
      "CONFLICT",
      "Video is starting on another screen at the same time. Try again.",
    );
  }

  private async release(enrollmentId: string, sessionId: string) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const slot = await this.slot(enrollmentId);
      if (!slot.revision) return;
      const saved = await this.storage.playbackSlots.compareAndSet(
        enrollmentId,
        slot.revision,
        {
          schemaVersion: 1,
          sessions: slot.sessions.filter((session) => session.id !== sessionId),
        },
      );
      if (saved.applied) return;
    }
  }

  /** Mark the ledger row ended (first reason wins) and free its screen. */
  private async end(id: string, reason: EndReason) {
    let enrollmentId: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const record = await this.storage.playbackSessions.getVersioned(id);
      if (!record) break;
      const value = readRecord(storedSessionSchema, record.value);
      enrollmentId = value.enrollmentId;
      if (value.endedAt !== null) break;
      const saved = await this.storage.playbackSessions.compareAndSet(
        id,
        record.revision,
        { ...value, endedAt: this.now(), endReason: reason },
      );
      if (saved.applied) break;
    }
    if (enrollmentId) await this.release(enrollmentId, id);
  }

  async issue(
    input: z.infer<typeof playbackSchema>,
    token: unknown,
    siteId: string,
  ): Promise<PlaybackGrant> {
    const access = await this.lms.canAccess(token, input);
    const pick = async () => {
      if ((await this.catalog.routeState()).active !== "primary")
        throw new DomainError(
          "VIDEO_PAUSED",
          "Video is paused for maintenance. Lesson notes and assignments are still available.",
        );
      const asset = await this.catalog.select(
        input.courseId,
        input.lessonId,
        input.locale,
        this.settings.enabled,
      );
      if (!asset)
        throw new DomainError(
          "MEDIA_NOT_READY",
          "This lesson's video is not available yet.",
        );
      return asset;
    };
    const asset = await pick();
    const drm = asset.value.provider === "doverunner";
    let manifestUrl = "";
    if (drm) {
      if (!this.settings.doverunner)
        throw new DomainError(
          "VIDEO_PAUSED",
          "Secure video is not configured for this site yet. Please contact your instructor.",
        );
      const manifests = asset.value.routes.primary.manifests;
      manifestUrl =
        (input.drm === "fairplay"
          ? manifests.hls
          : input.drm
            ? manifests.dash
            : null) ?? "";
      if (!manifestUrl)
        throw new DomainError(
          "UNSUPPORTED_DEVICE",
          "This browser cannot play secure video. Use a current Chrome, Edge, Firefox or Safari.",
        );
    }

    const now = this.now();
    const notAfter = Math.min(
      now + this.settings.licenseWindowMinutes * MINUTE,
      access.accessEndsAt,
    );
    const sessionId = secret();
    const deviceLabel = input.deviceLabel || "Unknown device";
    const replaced = await this.claim(
      access.enrollmentId,
      { id: sessionId, deviceLabel, issuedAt: now, notAfter },
      input.replaceSessionId,
    );
    const learner = await studentRef(
      this.settings.studentRefKey,
      access.enrollmentId,
    );
    const session: StoredSession = {
      schemaVersion: 1,
      siteId,
      studentRef: learner,
      studentId: access.enrollmentId,
      enrollmentId: access.enrollmentId,
      courseId: access.courseId,
      lessonId: access.lessonId,
      courseRevision: access.courseRevision,
      mediaAssetId: asset.id,
      provider: asset.value.provider,
      contentId: asset.value.contentId,
      locale: asset.value.locale,
      route: "primary",
      watermarkSessionId: null,
      drmPolicyVersion: SECURITY_POLICY[asset.value.provider],
      deviceLabel,
      issuedAt: now,
      notAfter,
      endedAt: null,
      endReason: null,
      previousSessionId: replaced,
    };
    try {
      await this.storage.playbackSessions.put(sessionId, session);
    } catch (error) {
      await this.release(access.enrollmentId, sessionId);
      throw error;
    }
    if (replaced) await this.end(replaced, "replaced");

    let grant: PlaybackGrant;
    const base = {
      sessionId,
      audioLocales: [asset.value.locale],
      expiresAt: new Date(notAfter).toISOString(),
      visibleMark: sessionId.slice(0, 8).toUpperCase(),
    };
    if (drm && input.drm) {
      const credentials = this.settings.doverunner!;
      // The license may be fetched up to the token's validity after minting;
      // subtract that so it never runs past the session's end.
      const licenseSeconds = Math.max(
        60,
        (notAfter - now) / 1000 - TOKEN_VALIDITY_SECONDS,
      );
      const licenseToken = await mintLicenseToken({
        credentials,
        drm: input.drm,
        userId: learner,
        contentId: asset.value.contentId,
        policy: streamingPolicy(
          licenseSeconds,
          this.settings.concurrentStreamLimit
            ? this.settings.deviceLimit
            : null,
        ),
        now,
      });
      grant = {
        ...base,
        provider: "doverunner",
        route: "primary",
        manifestUrl,
        drm: {
          [input.drm]: {
            licenseUrl: LICENSE_URL,
            token: licenseToken,
            ...(input.drm === "fairplay"
              ? { certificateUrl: fairPlayCertificateUrl(credentials.siteId) }
              : {}),
          },
        },
        licenseHeader: LICENSE_TOKEN_HEADER,
      };
    } else {
      grant = {
        ...base,
        provider: "wistia",
        mediaHashedId: asset.value.wistia!.mediaHashedId,
      };
    }

    // Revocation, unpublish, a pause or a replaced video may have landed during
    // the work above; none of them may receive a fresh grant.
    try {
      await this.lms.canAccess(token, input);
      if ((await pick()).id !== asset.id)
        throw new DomainError(
          "MEDIA_NOT_READY",
          "This lesson's video changed. Try again.",
        );
    } catch (error) {
      await this.end(sessionId, "revoked");
      throw error;
    }
    return grant;
  }

  async endPlayback(
    input: z.infer<typeof playbackEndSchema>,
    token: unknown,
  ): Promise<{ ended: true }> {
    const record = await this.storage.playbackSessions.getVersioned(
      input.sessionId,
    );
    if (
      !record ||
      !(await this.lms.owns(
        token,
        readRecord(storedSessionSchema, record.value).enrollmentId,
      ))
    )
      throw new DomainError(
        "ACCESS_DENIED",
        "Your learning session is no longer available.",
      );
    await this.end(input.sessionId, "ended");
    return { ended: true };
  }

  /**
   * Revocation, reissue and sign-out stop new playback for the enrollment at
   * once; a license already delivered keeps running to its own end time.
   */
  async endForEnrollment(enrollmentId: string): Promise<void> {
    for (const session of (await this.slot(enrollmentId)).sessions)
      await this.end(session.id, "revoked");
  }
}
