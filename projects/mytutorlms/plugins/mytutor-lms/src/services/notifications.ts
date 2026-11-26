import { z } from "zod";
import { render, type TemplateId } from "../email/templates.js";
import type { Locale } from "../model.js";
import { DomainError, readRecord } from "../validation.js";
import { maskEmail } from "./audit.js";
import { all, key, type DomainCollection } from "./shared.js";
import type { StudentDirectory } from "./students.js";

const MINUTE = 60 * 1000;
const BACKOFF = [1, 5, 30, 120].map((minutes) => minutes * MINUTE);
const SECRET_DATA = /^(code|token|secret|link)$/i;
/** Their codes and links are never stored, so they cannot be retried or resent. */
const ONE_SHOT = new Set(["sign_in_code", "invitation"]);
const dataSchema = z.record(
  z.string().max(64),
  z.union([z.string().max(2000), z.number()]),
);
export const notificationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  template: z.string().max(64),
  locale: z.enum(["vi", "en", "es"]),
  recipient: z.strictObject({
    type: z.enum(["student", "staff", "address"]),
    id: z.string().max(200).nullable(),
    email: z.email().max(254),
  }),
  recipientId: z.string().max(254),
  data: dataSchema.refine(
    (data) => !Object.keys(data).some((name) => SECRET_DATA.test(name)),
    "Notification data must not contain credentials.",
  ),
  status: z.enum(["queued", "sent", "failed", "suppressed"]),
  attempts: z.number().int().min(0),
  nextAttemptAt: z.number().int().min(0),
  providerMessageId: z.string().max(200).nullable(),
  lastError: z.string().max(64),
  createdAt: z.number().int().min(0),
  sentAt: z.number().int().min(0).nullable(),
});
type StoredNotification = z.infer<typeof notificationSchema>;

export interface EmailTransport {
  send(message: {
    to: string;
    subject: string;
    text: string;
    replyTo?: string;
  }): Promise<void>;
}
export interface NotificationInput {
  studentId?: string;
  email?: string;
  template: TemplateId;
  data: Record<string, string | number>;
  locale?: Locale;
  dedupeKey: string;
  /** Sends now (sign-in); credentials in `data` are used for this send only and never stored. */
  immediate?: boolean;
}
export interface NotificationResult {
  notificationId: string;
  status: "queued" | "sent" | "suppressed" | "failed";
}

/** Outbox for transactional email. Idempotent on (template, dedupeKey). */
export class NotificationService {
  constructor(
    private readonly notifications: DomainCollection,
    private readonly students: StudentDirectory,
    private readonly transport: EmailTransport | null,
    private readonly defaults: { locale: Locale; replyTo: string },
    private readonly now: () => number = Date.now,
  ) {}

  async send(input: NotificationInput): Promise<NotificationResult> {
    if (Boolean(input.studentId) === Boolean(input.email))
      throw new DomainError("VALIDATION", "Choose exactly one recipient.");
    const id = await key("notification", input.template, input.dedupeKey);
    const existing = await this.notifications.getVersioned(id);
    if (existing) {
      const value = readRecord(notificationSchema, existing.value);
      return {
        notificationId: id,
        status: value.status === "failed" ? "failed" : value.status,
      };
    }
    let recipient: StoredNotification["recipient"];
    let locale = input.locale ?? this.defaults.locale;
    let suppressed = false;
    if (input.studentId) {
      const student = await this.students.get(input.studentId);
      if (!student) throw new DomainError("NOT_FOUND", "Student not found.");
      recipient = {
        type: "student",
        id: student.id,
        email: student.value.email,
      };
      locale = input.locale ?? student.value.locale;
      suppressed = student.value.status !== "active";
    } else recipient = { type: "address", id: null, email: input.email! };
    const stored: StoredNotification = {
      schemaVersion: 1,
      template: input.template,
      locale,
      recipient,
      recipientId: recipient.id ?? recipient.email,
      data: Object.fromEntries(
        Object.entries(input.data).filter(([name]) => !SECRET_DATA.test(name)),
      ),
      status: suppressed ? "suppressed" : "queued",
      attempts: 0,
      nextAttemptAt: this.now(),
      providerMessageId: null,
      lastError: "",
      createdAt: this.now(),
      sentAt: null,
    };
    const created = await this.notifications.compareAndSet(id, null, stored);
    if (!created.applied) return this.send(input);
    if (suppressed) return { notificationId: id, status: "suppressed" };
    if (!input.immediate) return { notificationId: id, status: "queued" };
    const status = await this.deliver(id, created.revision, stored, input.data);
    return { notificationId: id, status };
  }

  private async deliver(
    id: string,
    revision: string,
    value: StoredNotification,
    data: Record<string, string | number>,
  ): Promise<"sent" | "queued" | "failed"> {
    const attempts = value.attempts + 1;
    let next: StoredNotification;
    try {
      if (!this.transport)
        throw new DomainError("EMAIL_UNAVAILABLE", "No email provider.");
      const message = render(value.template as TemplateId, value.locale, data);
      await this.transport.send({
        to: value.recipient.email,
        subject: message.subject,
        text: message.text,
        ...(this.defaults.replyTo ? { replyTo: this.defaults.replyTo } : {}),
      });
      next = {
        ...value,
        attempts,
        status: "sent",
        sentAt: this.now(),
        lastError: "",
      };
    } catch (error) {
      const code = error instanceof DomainError ? error.code : "PROVIDER_ERROR";
      // Codes must never be re-sent from storage, so sign-in failures end at once.
      const retry =
        code !== "EMAIL_UNAVAILABLE" &&
        !ONE_SHOT.has(value.template) &&
        attempts <= BACKOFF.length;
      next = {
        ...value,
        attempts,
        status: retry ? "queued" : "failed",
        nextAttemptAt: this.now() + (BACKOFF[attempts - 1] ?? 0),
        lastError: code,
      };
    }
    await this.notifications.compareAndSet(id, revision, next);
    return next.status === "sent"
      ? "sent"
      : next.status === "queued"
        ? "queued"
        : "failed";
  }

  /** Scheduled job: sends due queued notifications with backoff. */
  async dispatch(limit = 50): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    for (const row of (
      await all(this.notifications, { status: "queued" })
    ).slice(0, limit)) {
      const record = await this.notifications.getVersioned(row.id);
      if (!record) continue;
      const parsed = notificationSchema.safeParse(record.value);
      if (!parsed.success || parsed.data.nextAttemptAt > this.now()) continue;
      const status = await this.deliver(
        row.id,
        record.revision,
        parsed.data,
        parsed.data.data,
      );
      if (status === "sent") sent++;
      if (status === "failed") failed++;
    }
    return { sent, failed };
  }

  async list(status?: StoredNotification["status"]) {
    const rows = await all(this.notifications, status ? { status } : undefined);
    return rows.flatMap((row) => {
      const parsed = notificationSchema.safeParse(row.data);
      if (!parsed.success) return [];
      const value = parsed.data;
      return [
        {
          id: row.id,
          template: value.template,
          recipient: maskEmail(value.recipient.email),
          status: value.status,
          attempts: value.attempts,
          lastError: value.lastError,
          createdAt: new Date(value.createdAt).toISOString(),
          sentAt:
            value.sentAt === null ? null : new Date(value.sentAt).toISOString(),
        },
      ];
    });
  }

  /** Requeues a failed message; sign-in codes are never resent. */
  async resend(id: string): Promise<{ status: "queued" }> {
    const record = await this.notifications.getVersioned(id);
    if (!record) throw new DomainError("NOT_FOUND", "Message not found.");
    const value = readRecord(notificationSchema, record.value);
    if (value.status !== "failed" || ONE_SHOT.has(value.template))
      throw new DomainError(
        "VALIDATION",
        "Only failed messages can be resent.",
      );
    const saved = await this.notifications.compareAndSet(id, record.revision, {
      ...value,
      status: "queued",
      attempts: 0,
      nextAttemptAt: this.now(),
    });
    if (!saved.applied)
      throw new DomainError("CONFLICT", "This message changed.");
    return { status: "queued" };
  }
}
