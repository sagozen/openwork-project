import { z } from "zod";
import { without } from "../object.js";
import type { ActorRef } from "../model.js";
import { DomainError, enrollmentSchema } from "../validation.js";
import type { AuditLog } from "./audit.js";
import { inviteRef, type EntitlementService } from "./entitlements.js";
import { key, type DomainCollection } from "./shared.js";
import type { StudentDirectory } from "./students.js";

const DAY = 24 * 60 * 60 * 1000;
const PAGE = 100;
export const migrateSchema = z.strictObject({
  dryRun: z.boolean(),
  cursor: z.string().max(200).optional(),
  revertToV1: z.boolean().optional(),
  backupConfirmedAt: z.string().datetime(),
});

export interface MigrationReport {
  scanned: number;
  v1Enrollments: number;
  distinctEmails: number;
  studentsToCreate: number;
  entitlementsToCreate: number;
  migrated: number;
  reverted: number;
  conflicts: string[];
}
export interface IntegrityStorage {
  [name: string]: DomainCollection;
}

/**
 * Owner-run migration from 0.2 invitation enrollments to student accounts.
 * Idempotent and resumable; never deletes and never touches the encryption key.
 */
export class AccountMigration {
  constructor(
    private readonly enrollments: DomainCollection,
    private readonly students: StudentDirectory,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditLog,
    private readonly now: () => number = Date.now,
  ) {}

  async run(
    input: z.infer<typeof migrateSchema>,
    actor: ActorRef,
  ): Promise<{ report: MigrationReport; cursor: string | null }> {
    const backupAt = Date.parse(input.backupConfirmedAt);
    if (!(backupAt <= this.now() && this.now() - backupAt <= DAY))
      throw new DomainError(
        "VALIDATION",
        "Confirm a verified backup taken in the last 24 hours before migrating.",
      );
    const page = await this.enrollments.query({
      limit: PAGE,
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
    const report: MigrationReport = {
      scanned: page.items.length,
      v1Enrollments: 0,
      distinctEmails: 0,
      studentsToCreate: 0,
      entitlementsToCreate: 0,
      migrated: 0,
      reverted: 0,
      conflicts: [],
    };
    const emails = new Set<string>();
    for (const row of page.items) {
      const parsed = enrollmentSchema.safeParse(row.data);
      if (!parsed.success) {
        report.conflicts.push(row.id);
        continue;
      }
      const enrollment = parsed.data;
      if (input.revertToV1) {
        // Escape hatch: only rows that came from invitations go back to version 1.
        if (
          enrollment.schemaVersion === 2 &&
          enrollment.invitationExpiresAt !== null &&
          row.id === (await key(enrollment.courseId, enrollment.email))
        ) {
          if (!input.dryRun) {
            // A conditional update cannot remove `studentId`; write the exact v1 record.
            const current = await this.enrollments.getVersioned(row.id);
            const fresh = current
              ? enrollmentSchema.safeParse(current.value)
              : null;
            let reverted = { applied: false };
            if (
              current &&
              fresh?.success &&
              fresh.data.schemaVersion === 2 &&
              fresh.data.invitationExpiresAt !== null
            ) {
              const rest = without(fresh.data, "studentId");
              reverted = await this.enrollments.compareAndSet(
                row.id,
                current.revision,
                {
                  ...rest,
                  schemaVersion: 1,
                  invitationExpiresAt: fresh.data.invitationExpiresAt,
                },
              );
            }
            if (reverted.applied) report.reverted++;
            else report.conflicts.push(row.id);
          } else report.reverted++;
        }
        continue;
      }
      if (enrollment.schemaVersion === 2) {
        // A link without its grant (for example a crash mid-run): record the grant now.
        if (
          !input.dryRun &&
          enrollment.active &&
          row.id === (await key(enrollment.courseId, enrollment.email))
        )
          await this.entitlements
            .grant({
              studentId: enrollment.studentId,
              courseId: enrollment.courseId,
              source: "invite",
              sourceRef: inviteRef(row.id, enrollment.invitedAt),
              expiresAt: null,
              actor,
              reason: "Account migration",
            })
            .catch(() => report.conflicts.push(row.id));
        continue;
      }
      report.v1Enrollments++;
      if (
        !emails.has(enrollment.email) &&
        !(await this.students.byEmail(enrollment.email))
      )
        report.studentsToCreate++;
      emails.add(enrollment.email);
      if (enrollment.active) report.entitlementsToCreate++;
      if (input.dryRun) continue;
      const { student } = await this.students.resolveOrCreate({
        email: enrollment.email,
        name: enrollment.name,
        locale: "vi",
        createdBy: "migration",
        verified: false,
      });
      // Matching on generation lets a concurrent revoke or reissue win; the row is retried next pass.
      const linked = await this.enrollments.updateIf(row.id, {
        where: { generation: enrollment.generation },
        set: { schemaVersion: 2, studentId: student.id },
      });
      if (!linked.applied) {
        report.conflicts.push(row.id);
        continue;
      }
      if (enrollment.active)
        await this.entitlements
          .grant({
            studentId: student.id,
            courseId: enrollment.courseId,
            source: "invite",
            sourceRef: inviteRef(row.id, enrollment.invitedAt),
            expiresAt: null,
            actor,
            reason: "Account migration",
          })
          .catch(() => report.conflicts.push(row.id));
      await this.audit.record({
        actor,
        action: "migration.enrollment",
        subject: { type: "enrollment", id: row.id },
        after: { studentId: student.id, active: enrollment.active },
        key: await key("audit", "migration", row.id),
      });
      report.migrated++;
    }
    report.distinctEmails = emails.size;
    if (!input.cursor)
      await this.audit.record({
        actor,
        action: input.revertToV1 ? "migration.revert" : "migration.run",
        subject: { type: "site", id: "accounts" },
        after: { dryRun: input.dryRun },
        reason: `Backup confirmed at ${input.backupConfirmedAt}`,
      });
    return {
      report,
      cursor: page.hasMore && page.cursor ? page.cursor : null,
    };
  }
}

/** Collection counts and schema versions, compared by backup and restore verification. */
export async function integrity(collections: IntegrityStorage) {
  const result: {
    name: string;
    count: number;
    schemaVersions: Record<string, number>;
  }[] = [];
  let v1Enrollments = 0;
  for (const [name, collection] of Object.entries(collections)) {
    let count = 0;
    const versions: Record<string, number> = {};
    let cursor: string | undefined;
    do {
      const page = await collection.query({
        limit: PAGE,
        ...(cursor ? { cursor } : {}),
      });
      for (const row of page.items) {
        count++;
        const version = String(
          (row.data as { schemaVersion?: unknown })?.schemaVersion ?? "none",
        );
        versions[version] = (versions[version] ?? 0) + 1;
        if (name === "enrollments" && version === "1") v1Enrollments++;
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    result.push({ name, count, schemaVersions: versions });
  }
  return {
    collections: result,
    v1Enrollments,
    generatedAt: new Date().toISOString(),
  };
}
