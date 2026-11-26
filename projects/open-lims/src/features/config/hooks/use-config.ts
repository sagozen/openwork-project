import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createQueryKeys, useApiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth/AuthProvider";
import { configApi } from "../api";
import type { CatalogGroup, ConfigBranch, ConfigCatalogItem } from "../types";

export const configKeys = createQueryKeys("configuration");

const branchKey = ["configuration", "branches"] as const;
const parameterKey = ["configuration", "system-parameters"] as const;

export function useConfigBranches(enabled = true) {
  const api = useApiClient();
  const { usesClerk } = useAuth();
  return useQuery({
    queryKey: branchKey,
    queryFn: () => configApi.branches(api),
    enabled: enabled && usesClerk,
  });
}

export function useCatalogItems(group?: CatalogGroup, enabled = true) {
  const api = useApiClient();
  const { usesClerk } = useAuth();
  return useQuery({
    queryKey: configKeys.list({ group: group ?? null }),
    queryFn: () => configApi.catalogItems(api, group),
    enabled: enabled && usesClerk,
  });
}

export function useSystemParameters(enabled = true) {
  const api = useApiClient();
  const { usesClerk } = useAuth();
  return useQuery({
    queryKey: parameterKey,
    queryFn: () => configApi.systemParameters(api),
    enabled: enabled && usesClerk,
  });
}

export function usePatchBranch() {
  const api = useApiClient();
  const cache = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: Partial<Pick<ConfigBranch, "name" | "address" | "phone" | "active">>;
    }) => configApi.patchBranch(api, id, patch),
    onSuccess: () => cache.invalidateQueries({ queryKey: branchKey }),
  });
}

export function usePatchCatalogItem() {
  const api = useApiClient();
  const cache = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: Partial<Pick<ConfigCatalogItem, "name" | "unit" | "active" | "resultConfiguration">>;
    }) => configApi.patchCatalogItem(api, id, patch),
    onSuccess: () => cache.invalidateQueries({ queryKey: configKeys.all }),
  });
}

export function usePatchSystemParameter() {
  const api = useApiClient();
  const cache = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      configApi.patchSystemParameter(api, key, value),
    onSuccess: () => cache.invalidateQueries({ queryKey: parameterKey }),
  });
}
