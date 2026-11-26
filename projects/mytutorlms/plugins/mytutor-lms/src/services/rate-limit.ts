import { z } from "zod";
import { DomainError } from "../validation.js";
import { key, type DomainCollection } from "./shared.js";

const counterSchema = z.strictObject({
  schemaVersion: z.literal(1),
  count: z.number().int().min(0),
  windowStart: z.number().int().min(0),
  expiresAt: z.number().int().min(0),
});

export interface Limit {
  scope: string;
  /** An email hash or a daily-salted IP hash; raw IPs are never stored. */
  subject: string;
  max: number;
  windowMs: number;
}

/** Fixed-window counters with one compare-and-set record per scope, subject and window. */
export class RateLimiter {
  constructor(
    private readonly counters: DomainCollection,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds until the next window when any limit is exhausted; null when all pass. */
  async check(limits: Limit[]): Promise<number | null> {
    let retryAfter: number | null = null;
    for (const limit of limits) {
      const { id, windowStart } = await this.slot(limit);
      const record = await this.counters.getVersioned(id);
      const parsed = record ? counterSchema.safeParse(record.value) : null;
      if (parsed?.success && parsed.data.count >= limit.max)
        retryAfter = Math.max(
          retryAfter ?? 0,
          Math.ceil((windowStart + limit.windowMs - this.now()) / 1000),
        );
    }
    return retryAfter;
  }

  /** Counts one use against every limit. */
  async hit(limits: Limit[]): Promise<void> {
    for (const limit of limits) {
      const { id, windowStart } = await this.slot(limit);
      for (let attempt = 0; attempt < 5; attempt++) {
        const record = await this.counters.getVersioned(id);
        const parsed = record ? counterSchema.safeParse(record.value) : null;
        const count = parsed?.success ? parsed.data.count : 0;
        const saved = await this.counters.compareAndSet(
          id,
          record?.revision ?? null,
          {
            schemaVersion: 1,
            count: count + 1,
            windowStart,
            expiresAt: windowStart + limit.windowMs,
          },
        );
        if (saved.applied) break;
      }
    }
  }

  /** Throws RATE_LIMITED with the same message whoever is asking. */
  async consume(limits: Limit[]): Promise<void> {
    const retryAfter = await this.check(limits);
    if (retryAfter !== null)
      throw new DomainError(
        "RATE_LIMITED",
        `Too many attempts. Try again in ${Math.max(1, Math.ceil(retryAfter / 60))} minutes.`,
      );
    await this.hit(limits);
  }

  private async slot(limit: Limit) {
    const windowStart =
      Math.floor(this.now() / limit.windowMs) * limit.windowMs;
    return {
      windowStart,
      id: await key("rl", limit.scope, limit.subject, windowStart),
    };
  }
}
