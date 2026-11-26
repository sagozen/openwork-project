import { z } from "zod";
import type { Locale, StudentProfile } from "../model.js";
import { DomainError, label, readRecord } from "../validation.js";
import { key, secret, type DomainCollection } from "./shared.js";

const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
export const emailSchema = z
  .string()
  .max(254)
  .trim()
  .toLowerCase()
  .pipe(z.email());
export const studentRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  email: z.email().max(254),
  name: label,
  locale: z.enum(["vi", "en", "es"]),
  status: z.enum(["active", "disabled"]),
  /** Rotating it signs out every device. */
  generation: hex64,
  emailVerifiedAt: z.number().int().min(0).nullable(),
  createdAt: z.number().int().min(0),
  createdBy: z.enum(["self", "invite", "grant", "migration"]),
  lastSignInAt: z.number().int().min(0).nullable(),
  testAccount: z.boolean(),
});
export type StudentRecord = z.infer<typeof studentRecordSchema>;
const emailClaimSchema = z.strictObject({
  schemaVersion: z.literal(1),
  studentId: hex64,
});

export interface StudentStorage {
  students: DomainCollection;
  /** One record per email address: makes "one student per email" atomic. */
  studentEmails: DomainCollection;
}
export interface Student {
  id: string;
  revision: string;
  value: StudentRecord;
}

export function profile(id: string, value: StudentRecord): StudentProfile {
  return {
    id,
    email: value.email,
    name: value.name,
    locale: value.locale,
    emailVerified: value.emailVerifiedAt !== null,
    createdAt: new Date(value.createdAt).toISOString(),
  };
}

export class StudentDirectory {
  constructor(
    private readonly storage: StudentStorage,
    private readonly now: () => number = Date.now,
  ) {}

  async get(id: string): Promise<Student | null> {
    const record = await this.storage.students.getVersioned(id);
    if (!record) return null;
    return {
      id,
      revision: record.revision,
      value: readRecord(studentRecordSchema, record.value),
    };
  }

  private async claim(email: string) {
    const claimKey = await key("email", email);
    const record = await this.storage.studentEmails.getVersioned(claimKey);
    const student = record
      ? await this.get(readRecord(emailClaimSchema, record.value).studentId)
      : null;
    return {
      key: claimKey,
      revision: record?.revision ?? null,
      // A claim left behind by an email change no longer matches its student.
      student: student?.value.email === email ? student : null,
    };
  }

  async byEmail(email: string): Promise<Student | null> {
    return (await this.claim(email)).student;
  }

  /**
   * Returns the student for an email, creating one if absent. Concurrent
   * callers converge on one student through a compare-and-set on the email claim.
   */
  async resolveOrCreate(input: {
    email: string;
    name: string;
    locale: Locale;
    createdBy: StudentRecord["createdBy"];
    verified: boolean;
  }): Promise<{ student: Student; created: boolean }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const claim = await this.claim(input.email);
      if (claim.student) return { student: claim.student, created: false };
      const id = secret();
      const value: StudentRecord = {
        schemaVersion: 1,
        email: input.email,
        name: input.name.trim() || input.email.split("@")[0]!.slice(0, 160),
        locale: input.locale,
        status: "active",
        generation: secret(),
        emailVerifiedAt: input.verified ? this.now() : null,
        createdAt: this.now(),
        createdBy: input.createdBy,
        lastSignInAt: null,
        testAccount: false,
      };
      // Write the student first; one that loses the claim race is unreachable and harmless.
      const created = await this.storage.students.compareAndSet(
        id,
        null,
        value,
      );
      if (!created.applied) continue;
      const claimed = await this.storage.studentEmails.compareAndSet(
        claim.key,
        claim.revision,
        { schemaVersion: 1, studentId: id },
      );
      if (claimed.applied)
        return {
          student: { id, revision: created.revision, value },
          created: true,
        };
    }
    throw new DomainError(
      "CONFLICT",
      "This account is being created elsewhere. Try again.",
    );
  }

  async update(
    student: Student,
    patch: Partial<StudentRecord>,
  ): Promise<Student> {
    const value = readRecord(studentRecordSchema, {
      ...student.value,
      ...patch,
    });
    const saved = await this.storage.students.compareAndSet(
      student.id,
      student.revision,
      value,
    );
    if (!saved.applied)
      throw new DomainError("CONFLICT", "This account changed. Try again.");
    return { id: student.id, revision: saved.revision, value };
  }

  /** Claims the new email (fails closed if another student holds it), then updates the record. */
  async changeEmail(student: Student, email: string): Promise<Student> {
    const claim = await this.claim(email);
    if (claim.student && claim.student.id !== student.id)
      throw new DomainError("CONFLICT", "That email is already used.");
    const claimed = await this.storage.studentEmails.compareAndSet(
      claim.key,
      claim.revision,
      { schemaVersion: 1, studentId: student.id },
    );
    if (!claimed.applied)
      throw new DomainError("CONFLICT", "That email is already used.");
    return this.update(student, {
      email,
      generation: secret(),
      emailVerifiedAt: null,
    });
  }

  rotate(student: Student): Promise<Student> {
    return this.update(student, { generation: secret() });
  }
}
