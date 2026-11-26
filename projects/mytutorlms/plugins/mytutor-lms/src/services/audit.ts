import { z } from "zod";
import type { ActorRef, AuditEventView } from "../model.js";
import { DomainError, text } from "../validation.js";
import type { DomainCollection } from "./shared.js";

const MAX_SNAPSHOT_BYTES = 4096;
const actorSchema = z.strictObject({
  type: z.enum(["owner", "instructor", "assistant", "student", "system", "ai"]),
  id: z.string().max(200),
  label: z.string().max(200),
});
export const auditEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  siteId: z.string().max(253),
  at: z.number().int().min(0),
  actor: actorSchema,
  actorId: z.string().max(200),
  action: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
  subject: z.strictObject({
    type: z.string().max(64),
    id: z.string().max(200),
  }),
  subjectId: z.string().max(200),
  before: z.unknown(),
  after: z.unknown(),
  reason: text(500),
  requestId: z.string().max(100),
});
type StoredAudit = z.infer<typeof auditEventSchema>;

const SECRET_KEY = /(hash|token|secret|code|publickey|password|link)$/i;
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}
/** Drops credentials and masks emails so audit rows never hold secrets or raw addresses. */
export function redact(value: unknown): unknown {
  const walk = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(([name]) => !SECRET_KEY.test(name))
          .map(([name, inner]) => [
            name,
            /email/i.test(name) && typeof inner === "string"
              ? maskEmail(inner)
              : walk(inner),
          ]),
      );
    return item;
  };
  const cleaned = walk(value);
  if (cleaned === undefined) return null;
  return new TextEncoder().encode(JSON.stringify(cleaned)).byteLength >
    MAX_SNAPSHOT_BYTES
    ? { truncated: true }
    : cleaned;
}

export interface AuditInput {
  actor: ActorRef;
  action: string;
  subject: { type: string; id: string };
  before?: unknown;
  after?: unknown;
  reason?: string;
  /** Deterministic key for idempotent operations; a replay writes nothing new. */
  key?: string;
  requestId?: string;
}

function randomSuffix(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Append-only audit log: records are created once and never updated or deleted. */
export class AuditLog {
  constructor(
    private readonly events: DomainCollection,
    private readonly siteId: string,
    private readonly now: () => number = Date.now,
  ) {}

  async record(input: AuditInput): Promise<void> {
    const at = this.now();
    const id =
      input.key ?? `${at.toString(36).padStart(9, "0")}-${randomSuffix()}`;
    const event: StoredAudit = {
      schemaVersion: 1,
      siteId: this.siteId,
      at,
      actor: input.actor,
      actorId: input.actor.id,
      action: input.action,
      subject: input.subject,
      subjectId: input.subject.id,
      before: redact(input.before ?? null),
      after: redact(input.after ?? null),
      reason: (input.reason ?? "").slice(0, 500),
      requestId: input.requestId ?? "",
    };
    const parsed = auditEventSchema.safeParse(event);
    if (!parsed.success)
      throw new DomainError("VALIDATION", "The audit event is not valid.");
    // Create-if-absent: a replay with the same key is a no-op, never an overwrite.
    await this.events.compareAndSet(id, null, parsed.data);
  }

  async list(filter: {
    subjectId?: string;
    actorId?: string;
    action?: string;
    cursor?: string;
  }): Promise<{ items: AuditEventView[]; cursor: string | null }> {
    const where = Object.fromEntries(
      Object.entries({
        subjectId: filter.subjectId,
        actorId: filter.actorId,
        action: filter.action,
      }).filter(([, value]) => value !== undefined),
    ) as Record<string, string>;
    const page = await this.events.query({
      where,
      orderBy: { at: "desc" },
      limit: 50,
      ...(filter.cursor ? { cursor: filter.cursor } : {}),
    });
    const items: AuditEventView[] = [];
    for (const row of page.items) {
      const parsed = auditEventSchema.safeParse(row.data);
      if (!parsed.success) continue;
      const value = parsed.data;
      items.push({
        id: row.id,
        at: new Date(value.at).toISOString(),
        actor: value.actor,
        action: value.action,
        subject: value.subject,
        before: value.before,
        after: value.after,
        reason: value.reason,
      });
    }
    return {
      items,
      cursor: page.hasMore && page.cursor ? page.cursor : null,
    };
  }
}
