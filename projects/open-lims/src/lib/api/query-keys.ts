export interface QueryKeyFactory {
  all: readonly [string];
  lists(): readonly [string, "list"];
  list(filters?: object): readonly [string, "list", object?];
  details(): readonly [string, "detail"];
  detail(id: string): readonly [string, "detail", string];
}

export function createQueryKeys(namespace: string): QueryKeyFactory {
  return {
    all: [namespace] as const,
    lists: () => [namespace, "list"] as const,
    list: (filters) => [namespace, "list", filters] as const,
    details: () => [namespace, "detail"] as const,
    detail: (id) => [namespace, "detail", id] as const,
  };
}
