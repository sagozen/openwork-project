import type { StorageCollection } from "emdash";
import type { z } from "zod";
import type {
  LiveSession,
  PublicLiveSession,
  StudentLiveSession,
} from "../model.js";
import {
  DomainError,
  storedLiveSessionSchema,
  type deleteLiveSessionSchema,
  type saveLiveSessionSchema,
  type StoredLiveSession,
} from "../validation.js";
import { all, type DomainCollection } from "./shared.js";

export type LiveSessionCollection = DomainCollection &
  Pick<StorageCollection, "compareAndDelete">;

const MINUTE = 60 * 1000;
/** Students still see a session for this long after it ends, then it is hidden. */
export const ENDED_VISIBLE_MS = 2 * 60 * MINUTE;

export const sessionEnd = (value: StoredLiveSession) =>
  value.startsAt + value.durationMinutes * MINUTE;
const iso = (value: number) => new Date(value).toISOString();

function publicView(id: string, value: StoredLiveSession): PublicLiveSession {
  return {
    id,
    title: value.title,
    startsAt: iso(value.startsAt),
    durationMinutes: value.durationMinutes,
  };
}
function studentView(id: string, value: StoredLiveSession): StudentLiveSession {
  return {
    ...publicView(id, value),
    joinUrl: value.joinUrl,
    passcode: value.passcode,
    notes: value.notes,
  };
}

/**
 * Scheduled live classes (Zoom or any HTTPS meeting link) of a course. The
 * caller decides who may see what: staff routes check the course role,
 * classrooms reach `forStudents` only through the course access check, and
 * the public catalog gets titles and times only.
 */
export class LiveSessionService {
  constructor(
    private readonly sessions: LiveSessionCollection,
    private readonly now: () => number = Date.now,
  ) {}

  /** Readable sessions of a course, earliest first. Malformed rows are skipped. */
  private async rows(courseId: string) {
    const rows: { id: string; value: StoredLiveSession }[] = [];
    for (const row of await all(this.sessions, { courseId })) {
      const parsed = storedLiveSessionSchema.safeParse(row.data);
      if (parsed.success && parsed.data.courseId === courseId)
        rows.push({ id: row.id, value: parsed.data });
      else console.error("[mytutor-lms] skipped unreadable live session");
    }
    return rows.sort(
      (a, b) => a.value.startsAt - b.value.startsAt || a.id.localeCompare(b.id),
    );
  }

  /** Every session with its revision, for the workspace. */
  async list(courseId: string): Promise<LiveSession[]> {
    const sessions: LiveSession[] = [];
    for (const row of await this.rows(courseId)) {
      const record = await this.sessions.getVersioned(row.id);
      if (!record) continue;
      const parsed = storedLiveSessionSchema.safeParse(record.value);
      if (!parsed.success || parsed.data.courseId !== courseId) continue;
      sessions.push({
        ...studentView(row.id, parsed.data),
        courseId,
        createdAt: iso(parsed.data.createdAt),
        updatedAt: iso(parsed.data.updatedAt),
        revision: record.revision,
      });
    }
    return sessions;
  }

  /** Upcoming, in-progress and recently ended sessions, with join details. */
  async forStudents(courseId: string): Promise<StudentLiveSession[]> {
    const cutoff = this.now() - ENDED_VISIBLE_MS;
    return (await this.rows(courseId))
      .filter((row) => sessionEnd(row.value) > cutoff)
      .map((row) => studentView(row.id, row.value));
  }

  /** Sessions that have not ended: titles and times only. */
  async upcoming(courseId: string): Promise<PublicLiveSession[]> {
    const now = this.now();
    return (await this.rows(courseId))
      .filter((row) => sessionEnd(row.value) > now)
      .map((row) => publicView(row.id, row.value));
  }

  async courseOf(id: string): Promise<string | null> {
    const record = await this.sessions.getVersioned(id);
    const parsed = record
      ? storedLiveSessionSchema.safeParse(record.value)
      : null;
    return parsed?.success ? parsed.data.courseId : null;
  }

  /**
   * Creates (revision null) or updates a session. A session never moves to
   * another course, so a course-scoped role cannot take over another
   * course's session by naming its own course.
   */
  async save(input: z.infer<typeof saveLiveSessionSchema>): Promise<{
    session: LiveSession;
    before: StoredLiveSession | null;
  }> {
    const existing = await this.sessions.getVersioned(input.id);
    let before: StoredLiveSession | null = null;
    if (existing) {
      const parsed = storedLiveSessionSchema.safeParse(existing.value);
      if (!parsed.success || parsed.data.courseId !== input.value.courseId)
        throw new DomainError("NOT_FOUND", "Live session not found.");
      before = parsed.data;
      if (input.revision === null)
        throw new DomainError(
          "CONFLICT",
          "This live session already exists. Reload before saving.",
        );
    } else if (input.revision !== null)
      throw new DomainError("NOT_FOUND", "Live session not found.");
    if (existing && existing.revision !== input.revision)
      throw new DomainError(
        "CONFLICT",
        "This live session changed. Reload before saving.",
      );
    const now = this.now();
    const value: StoredLiveSession = {
      schemaVersion: 1,
      courseId: input.value.courseId,
      title: input.value.title,
      startsAt: Date.parse(input.value.startsAt),
      durationMinutes: input.value.durationMinutes,
      joinUrl: input.value.joinUrl,
      passcode: input.value.passcode,
      notes: input.value.notes,
      createdAt: before?.createdAt ?? now,
      updatedAt: now,
    };
    const saved = await this.sessions.compareAndSet(
      input.id,
      input.revision,
      value,
    );
    if (!saved.applied)
      throw new DomainError(
        "CONFLICT",
        "This live session changed. Reload before saving.",
      );
    return {
      session: {
        ...studentView(input.id, value),
        courseId: value.courseId,
        createdAt: iso(value.createdAt),
        updatedAt: iso(value.updatedAt),
        revision: saved.revision,
      },
      before,
    };
  }

  /** Deletes the exact revision the caller saw; returns what was deleted. */
  async remove(
    input: z.infer<typeof deleteLiveSessionSchema>,
  ): Promise<StoredLiveSession> {
    const existing = await this.sessions.getVersioned(input.id);
    const parsed = existing
      ? storedLiveSessionSchema.safeParse(existing.value)
      : null;
    if (!existing || !parsed?.success)
      throw new DomainError("NOT_FOUND", "Live session not found.");
    const deleted = await this.sessions.compareAndDelete(
      input.id,
      input.revision,
    );
    if (!deleted.applied)
      throw new DomainError(
        "CONFLICT",
        "This live session changed. Reload before deleting.",
      );
    return parsed.data;
  }
}
