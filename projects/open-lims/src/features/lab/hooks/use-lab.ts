import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createQueryKeys, useApiClient } from "@/lib/api";
import { labApi } from "../api";
import type { AnalysisTaskFilters } from "../types";

export const labKeys = createQueryKeys("analysis-tasks");
export function useAnalysisTasks(filters: AnalysisTaskFilters, enabled = true) {
  const api = useApiClient();
  return useQuery({
    queryKey: labKeys.list(filters),
    queryFn: () => labApi.list(api, filters),
    enabled,
  });
}
export function useAnalysisTask(code: string | undefined, enabled = true) {
  const api = useApiClient();
  return useQuery({
    queryKey: labKeys.detail(code ?? ""),
    queryFn: () => labApi.detail(api, code!),
    enabled: enabled && Boolean(code),
  });
}
export function useLabMutation<T, R = unknown>(
  run: (api: ReturnType<typeof useApiClient>, input: T) => Promise<R>,
) {
  const api = useApiClient();
  const cache = useQueryClient();
  return useMutation({
    mutationFn: (input: T) => run(api, input),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: labKeys.all });
    },
  });
}
