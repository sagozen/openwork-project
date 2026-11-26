import { z } from "zod";
import type { Locale, SignedIn, StudentProfile } from "../model.js";
import { DomainError, text } from "../validation.js";
import { maskEmail, type AuditLog } from "./audit.js";
import type { NotificationService } from "./notifications.js";
import type { RateLimiter } from "./rate-limit.js";
import {
  all,
  digest,
  key,
  sameHash,
  secret,
  type DomainCollection,
} from "./shared.js";
import {
  emailSchema,
  profile,
  type Student,
  type StudentDirectory,
} from "./students.js";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const CHALLENGE_TTL = 15 * MINUTE;
const MAX_ATTEMPTS = 5;
const SESSION_TTL = 30 * DAY;
const SEEN_INTERVAL = 10 * MINUTE;
const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.number().int().min(0).max(8_640_000_000_000_000);
const tokenShape = z.string().regex(/^[a-f0-9]{64}\.[a-f0-9]{64}$/);

const challengeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  email: z.email().max(254),
  codeHash: hex64,
  linkHash: hex64,
  bindingHash: hex64,
  purpose: z.enum(["sign_in", "upgrade"]),
  legacyEnrollmentId: hex64.nullable(),
  expiresAt: timestamp,
  attempts: z.number().int().min(0),
  consumedAt: timestamp.nullable(),
});
type Challenge = z.infer<typeof challengeSchema>;
export const sessionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  studentId: hex64,
  tokenHash: hex64,
  studentGeneration: hex64,
  createdAt: timestamp,
  expiresAt: timestamp,
  lastSeenAt: timestamp,
  method: z.enum(["code", "link", "passkey", "invitation", "upgrade"]),
  deviceLabel: text(60),
  revokedAt: timestamp.nullable(),
});
type Session = z.infer<typeof sessionSchema>;

export const startSchema = z.strictObject({
  email: emailSchema,
  locale: z.enum(["vi", "en", "es"]),
});
export const verifyCodeSchema = z.strictObject({
  email: emailSchema,
  code: z.string().regex(/^\d{6}$/),
});
export const verifyLinkSchema = z.strictObject({
  token: tokenShape,
  confirm: z.boolean().optional(),
});
export const updateMeSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  locale: z.enum(["vi", "en", "es"]),
});
export const revokeSessionSchema = z.strictObject({ sessionId: hex64 });

export interface AccountStorage {
  signInChallenges: DomainCollection;
  studentSessions: DomainCollection;
}
export interface SiteRules {
  siteName: string;
  /** Absolute URL of the sign-in verification page; the link token goes in its fragment. */
  verifyUrl: string;
  selfSignup: boolean;
  locales: Locale[];
  dailySignInEmailCap: number;
}
export interface RequestOrigin {
  /** Pre-auth binding cookie value set by the theme bridge. */
  binding: string;
  /** Daily-salted hash of the client IP, or "" when unknown. */
  clientHash: string;
  userAgent: string;
}
export interface StudentSession {
  student: Student;
  session: { id: string; value: Session };
}

/** Uniform random 6-digit code. */
function code(): string {
  const limit = 4_294_000_000; // largest multiple of 1e6 below 2^32
  for (;;) {
    const [value] = crypto.getRandomValues(new Uint32Array(1));
    if (value! < limit) return String(value! % 1_000_000).padStart(6, "0");
  }
}
/** Coarse "Safari on iPhone" label derived on the server; not a fingerprint. */
export function deviceLabel(userAgent: string): string {
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "Browser";
  const device = /iPhone/.test(userAgent)
    ? "iPhone"
    : /iPad/.test(userAgent)
      ? "iPad"
      : /Android/.test(userAgent)
        ? "Android"
        : /Mac OS X/.test(userAgent)
          ? "Mac"
          : /Windows/.test(userAgent)
            ? "Windows"
            : /Linux/.test(userAgent)
              ? "Linux"
              : "device";
  return `${browser} on ${device}`;
}

export class AccountService {
  constructor(
    private readonly storage: AccountStorage,
    private readonly students: StudentDirectory,
    private readonly notifications: NotificationService,
    private readonly limits: RateLimiter,
    private readonly audit: AuditLog,
    private readonly now: () => number = Date.now,
  ) {}

  /** Always answers `{sent: true}` so the response never reveals whether an account exists. */
  async start(
    input: z.infer<typeof startSchema>,
    origin: RequestOrigin,
    site: SiteRules,
    purpose: { kind: "sign_in" } | { kind: "upgrade"; enrollmentId: string } = {
      kind: "sign_in",
    },
  ): Promise<{ sent: true }> {
    const emailHash = await key("email", input.email);
    await this.limits.consume([
      {
        scope: "signin:email:15m",
        subject: emailHash,
        max: 3,
        windowMs: 15 * MINUTE,
      },
      { scope: "signin:email:day", subject: emailHash, max: 10, windowMs: DAY },
      ...(origin.clientHash
        ? [
            {
              scope: "signin:ip:hour",
              subject: origin.clientHash,
              max: 20,
              windowMs: 60 * MINUTE,
            },
          ]
        : []),
      {
        scope: "signin:site:day",
        subject: "site",
        max: site.dailySignInEmailCap,
        windowMs: DAY,
      },
    ]);
    const existing = await this.students.byEmail(input.email);
    if (purpose.kind === "sign_in" && !existing && !site.selfSignup)
      return { sent: true };
    if (existing && existing.value.status !== "active") return { sent: true };
    const challengeKey = await key("challenge", input.email);
    const signInCode = code();
    const linkToken = `${challengeKey}.${secret()}`;
    const previous =
      await this.storage.signInChallenges.getVersioned(challengeKey);
    const challenge: Challenge = {
      schemaVersion: 1,
      email: input.email,
      codeHash: await digest(signInCode),
      linkHash: await digest(linkToken),
      bindingHash: await digest(origin.binding),
      purpose: purpose.kind,
      legacyEnrollmentId:
        purpose.kind === "upgrade" ? purpose.enrollmentId : null,
      expiresAt: this.now() + CHALLENGE_TTL,
      attempts: 0,
      consumedAt: null,
    };
    // A new challenge replaces (and so invalidates) the previous code and link.
    const saved = await this.storage.signInChallenges.compareAndSet(
      challengeKey,
      previous?.revision ?? null,
      challenge,
    );
    if (!saved.applied) return { sent: true };
    await this.notifications.send({
      email: input.email,
      template: "sign_in_code",
      locale: existing?.value.locale ?? input.locale,
      data: {
        siteName: site.siteName,
        code: signInCode,
        link: `${site.verifyUrl}#t=${linkToken}`,
      },
      // Unique per challenge, so every new code is actually sent.
      dedupeKey: `${challengeKey}:${challenge.linkHash}`,
      immediate: true,
    });
    return { sent: true };
  }

  private async challenge(challengeKey: string) {
    const record =
      await this.storage.signInChallenges.getVersioned(challengeKey);
    if (!record) return null;
    const parsed = challengeSchema.safeParse(record.value);
    return parsed.success
      ? { revision: record.revision, value: parsed.data }
      : null;
  }

  private expired(value: Challenge) {
    return (
      value.consumedAt !== null ||
      value.expiresAt <= this.now() ||
      value.attempts >= MAX_ATTEMPTS
    );
  }

  async verifyCode(
    input: z.infer<typeof verifyCodeSchema>,
    origin: RequestOrigin,
    locale: Locale,
  ): Promise<SignedIn & { upgradeEnrollmentId: string | null }> {
    if (origin.clientHash)
      await this.limits.consume([
        {
          scope: "verify:ip:hour",
          subject: origin.clientHash,
          max: 30,
          windowMs: 60 * MINUTE,
        },
      ]);
    const challengeKey = await key("challenge", input.email);
    const current = await this.challenge(challengeKey);
    if (!current || this.expired(current.value))
      throw new DomainError(
        "CHALLENGE_EXPIRED",
        "This code has expired. Request a new one.",
      );
    // Count the attempt before comparing, so parallel guesses cannot exceed the limit.
    const counted = await this.storage.signInChallenges.compareAndSet(
      challengeKey,
      current.revision,
      { ...current.value, attempts: current.value.attempts + 1 },
    );
    if (!counted.applied)
      throw new DomainError("CODE_INVALID", "That code is not correct.");
    if (!sameHash(await digest(input.code), current.value.codeHash))
      throw new DomainError(
        current.value.attempts + 1 >= MAX_ATTEMPTS
          ? "CHALLENGE_EXPIRED"
          : "CODE_INVALID",
        current.value.attempts + 1 >= MAX_ATTEMPTS
          ? "Too many wrong codes. Request a new one."
          : "That code is not correct.",
      );
    return this.complete(
      challengeKey,
      counted.revision,
      { ...current.value, attempts: current.value.attempts + 1 },
      "code",
      origin,
      locale,
    );
  }

  async verifyLink(
    input: z.infer<typeof verifyLinkSchema>,
    origin: RequestOrigin,
    locale: Locale,
  ): Promise<
    | (SignedIn & { upgradeEnrollmentId: string | null })
    | { confirm: { maskedEmail: string } }
  > {
    const challengeKey = input.token.slice(0, 64);
    const current = await this.challenge(challengeKey);
    if (
      !current ||
      this.expired(current.value) ||
      !sameHash(await digest(input.token), current.value.linkHash)
    )
      throw new DomainError(
        "CHALLENGE_EXPIRED",
        "This sign-in link has expired or was already used. Request a new one.",
      );
    // Opening a link in another browser could sign someone into a stranger's
    // account (login CSRF); ask before continuing.
    if (
      !sameHash(await digest(origin.binding), current.value.bindingHash) &&
      input.confirm !== true
    )
      return { confirm: { maskedEmail: maskEmail(current.value.email) } };
    return this.complete(
      challengeKey,
      current.revision,
      current.value,
      "link",
      origin,
      locale,
    );
  }

  private async complete(
    challengeKey: string,
    revision: string,
    value: Challenge,
    method: "code" | "link",
    origin: RequestOrigin,
    locale: Locale,
  ) {
    const consumed = await this.storage.signInChallenges.compareAndSet(
      challengeKey,
      revision,
      { ...value, consumedAt: this.now() },
    );
    if (!consumed.applied)
      throw new DomainError(
        "CHALLENGE_EXPIRED",
        "This code was already used. Request a new one.",
      );
    let { student } = await this.students.resolveOrCreate({
      email: value.email,
      name: "",
      locale,
      createdBy: "self",
      verified: true,
    });
    if (student.value.status !== "active")
      throw new DomainError("ACCESS_DENIED", "This account is disabled.");
    // The first verified sign-in rotates the account, ending any session an
    // invitation link opened before the owner of the email proved it.
    student = await this.students.update(student, {
      emailVerifiedAt: student.value.emailVerifiedAt ?? this.now(),
      lastSignInAt: this.now(),
      ...(student.value.emailVerifiedAt === null
        ? { generation: secret() }
        : {}),
    });
    const signedIn = await this.issue(
      student,
      value.purpose === "upgrade" ? "upgrade" : method,
      origin.userAgent,
    );
    return { ...signedIn, upgradeEnrollmentId: value.legacyEnrollmentId };
  }

  /** New random token per sign-in; only its hash is stored. */
  async issue(
    student: Student,
    method: Session["method"],
    userAgent: string,
  ): Promise<SignedIn> {
    const sessionId = secret();
    const token = `${sessionId}.${secret()}`;
    const now = this.now();
    const value: Session = {
      schemaVersion: 1,
      studentId: student.id,
      tokenHash: await digest(token),
      studentGeneration: student.value.generation,
      createdAt: now,
      expiresAt: now + SESSION_TTL,
      lastSeenAt: now,
      method,
      deviceLabel: deviceLabel(userAgent),
      revokedAt: null,
    };
    const saved = await this.storage.studentSessions.compareAndSet(
      sessionId,
      null,
      value,
    );
    if (!saved.applied)
      throw new DomainError("CONFLICT", "Please try signing in again.");
    return {
      sessionToken: token,
      expiresAt: new Date(value.expiresAt).toISOString(),
      student: profile(student.id, student.value),
    };
  }

  /** `studentAccess`: resolves a student session token or throws AUTH_REQUIRED. */
  async access(token: unknown): Promise<StudentSession> {
    const parsed = tokenShape.safeParse(token);
    const denied = () =>
      new DomainError(
        "AUTH_REQUIRED",
        "Your session has ended. Sign in again to continue.",
      );
    if (!parsed.success) throw denied();
    const sessionId = parsed.data.slice(0, 64);
    const record = await this.storage.studentSessions.getVersioned(sessionId);
    if (!record) throw denied();
    const session = sessionSchema.safeParse(record.value);
    if (
      !session.success ||
      !sameHash(await digest(parsed.data), session.data.tokenHash) ||
      session.data.revokedAt !== null ||
      session.data.expiresAt <= this.now()
    )
      throw denied();
    const student = await this.students.get(session.data.studentId);
    if (
      !student ||
      student.value.status !== "active" ||
      student.value.generation !== session.data.studentGeneration
    )
      throw denied();
    if (this.now() - session.data.lastSeenAt >= SEEN_INTERVAL)
      await this.storage.studentSessions.compareAndSet(
        sessionId,
        record.revision,
        {
          ...session.data,
          lastSeenAt: this.now(),
        },
      );
    return { student, session: { id: sessionId, value: session.data } };
  }

  /** Passkey registration and privacy requests need a sign-in from the last few minutes. */
  requireRecentSignIn(session: StudentSession, maxAgeMs = 10 * MINUTE) {
    if (this.now() - session.session.value.createdAt > maxAgeMs)
      throw new DomainError(
        "REAUTH_REQUIRED",
        "For your security, sign in again to continue.",
      );
  }

  /** Revokes this session only; idempotent and silent for unknown tokens. */
  async logout(token: unknown): Promise<{ loggedOut: true }> {
    const parsed = tokenShape.safeParse(token);
    if (!parsed.success) return { loggedOut: true };
    const sessionId = parsed.data.slice(0, 64);
    await this.storage.studentSessions.updateIf(sessionId, {
      where: { tokenHash: await digest(parsed.data), revokedAt: null },
      set: { revokedAt: this.now() },
    });
    return { loggedOut: true };
  }

  async logoutAll(current: StudentSession): Promise<{ loggedOut: true }> {
    await this.students.rotate(current.student);
    await this.audit.record({
      actor: { type: "student", id: current.student.id, label: "Student" },
      action: "student.logout_all",
      subject: { type: "student", id: current.student.id },
    });
    return { loggedOut: true };
  }

  async me(current: StudentSession) {
    const sessions = [];
    for (const row of await all(this.storage.studentSessions, {
      studentId: current.student.id,
    })) {
      const parsed = sessionSchema.safeParse(row.data);
      if (
        parsed.success &&
        parsed.data.revokedAt === null &&
        parsed.data.expiresAt > this.now() &&
        parsed.data.studentGeneration === current.student.value.generation
      )
        sessions.push({
          id: row.id,
          deviceLabel: parsed.data.deviceLabel,
          lastSeenAt: new Date(parsed.data.lastSeenAt).toISOString(),
          current: row.id === current.session.id,
        });
    }
    return {
      student: profile(current.student.id, current.student.value),
      sessions,
      passkeys: [] as never[],
    };
  }

  async updateMe(
    current: StudentSession,
    input: z.infer<typeof updateMeSchema>,
    locales: Locale[],
  ): Promise<StudentProfile> {
    if (!locales.includes(input.locale))
      throw new DomainError(
        "VALIDATION",
        "Choose one of this site's languages.",
      );
    const updated = await this.students.update(current.student, {
      name: input.name,
      locale: input.locale,
    });
    return profile(updated.id, updated.value);
  }

  async revokeSession(
    current: StudentSession,
    sessionId: string,
  ): Promise<{ revoked: true }> {
    const record = await this.storage.studentSessions.getVersioned(sessionId);
    const parsed = record ? sessionSchema.safeParse(record.value) : null;
    if (!parsed?.success || parsed.data.studentId !== current.student.id)
      throw new DomainError("NOT_FOUND", "Session not found.");
    await this.storage.studentSessions.updateIf(sessionId, {
      where: { revokedAt: null },
      set: { revokedAt: this.now() },
    });
    return { revoked: true };
  }
}
