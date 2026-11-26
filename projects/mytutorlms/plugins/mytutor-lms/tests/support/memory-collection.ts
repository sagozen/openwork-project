import assert from "node:assert/strict";
import type { StorageCollection, VersionedValue } from "emdash";
import type { DomainCollection } from "../../src/service.js";

// A typed model of only the public storage operations used by the domain.
// Writes mutate synchronously after explicit barriers; no sleeps or timing races.
export class MemoryCollection implements DomainCollection {
  readonly rows = new Map<string, VersionedValue<unknown>>();
  revision = 0;
  pageSize = 2;
  queryCalls = 0;
  beforeCas?: () => Promise<void>;
  beforePut?: () => Promise<void>;
  beforeQuery?: () => Promise<void>;
  beforeGet?: (id: string) => Promise<void>;

  async getVersioned(id: string): Promise<VersionedValue<unknown> | null> {
    await this.beforeGet?.(id);
    return structuredClone(this.rows.get(id) ?? null);
  }
  async compareAndSet(id: string, revision: string | null, value: unknown) {
    await this.beforeCas?.();
    if ((this.rows.get(id)?.revision ?? null) !== revision)
      return { applied: false } as const;
    const next = `r${++this.revision}`;
    this.rows.set(id, { revision: next, value: structuredClone(value) });
    return { applied: true, revision: next } as const;
  }
  async compareAndDelete(id: string, revision: string) {
    if (this.rows.get(id)?.revision !== revision)
      return { applied: false } as const;
    this.rows.delete(id);
    return { applied: true } as const;
  }
  async put(id: string, value: unknown): Promise<void> {
    await this.beforePut?.();
    this.rows.set(id, {
      revision: `r${++this.revision}`,
      value: structuredClone(value),
    });
  }
  async query(options: Parameters<StorageCollection["query"]>[0] = {}) {
    await this.beforeQuery?.();
    this.queryCalls++;
    const matching = [...this.rows].filter(([, row]) =>
      Object.entries(options.where ?? {}).every(([key, value]) => {
        assert.ok(row.value && typeof row.value === "object");
        return Object.is((row.value as Record<string, unknown>)[key], value);
      }),
    );
    const offset = Number(options.cursor ?? 0);
    const limit = Math.min(options.limit ?? 50, this.pageSize);
    const items = matching
      .slice(offset, offset + limit)
      .map(([id, row]) => ({ id, data: structuredClone(row.value) }));
    const hasMore = offset + limit < matching.length;
    return {
      items,
      hasMore,
      ...(hasMore ? { cursor: String(offset + limit) } : {}),
    };
  }
  async updateIf(
    id: string,
    args: Parameters<StorageCollection["updateIf"]>[1],
  ) {
    const row = this.rows.get(id);
    if (!row || !row.value || typeof row.value !== "object")
      return { applied: false } as const;
    const value = row.value as Record<string, unknown>;
    if (
      !Object.entries(args.where).every(([key, expected]) =>
        Object.is(value[key], expected),
      )
    )
      return { applied: false } as const;
    assert.equal(
      args.delta,
      undefined,
      "This test model supports the guarded set operations actually used by the domain.",
    );
    const data = { ...value, ...args.set };
    this.rows.set(id, {
      revision: `r${++this.revision}`,
      value: structuredClone(data),
    });
    return { applied: true, data } as const;
  }
}
