import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createQueryKeys, useApiClient } from "@/lib/api";
import { samplingApi } from "../api/sampling-api";
import { invalidateRequestRecords } from "@/features/request";

export const samplingKeys = createQueryKeys("sampling");
export const changeRequestKeys = createQueryKeys("field-change-requests");

export function useAssignments(
  filters: { date?: string; page?: number; size?: number } = {},
  enabled = true,
) {
  const api = useApiClient();
  return useQuery({
    queryKey: samplingKeys.list(filters),
    queryFn: () =>
      samplingApi.assignments(api, {
        ...filters,
        page: filters.page ?? 1,
        size: filters.size ?? 50,
      }),
    enabled,
  });
}
export function useAssignment(code?: string) {
  const api = useApiClient();
  return useQuery({
    queryKey: samplingKeys.detail(code ?? ""),
    queryFn: () => samplingApi.detail(api, code!),
    enabled: Boolean(code),
  });
}
export function useChangeRequests(
  filters: { status?: string; page?: number; size?: number } = {},
  enabled = true,
) {
  const api = useApiClient();
  return useQuery({
    queryKey: changeRequestKeys.list(filters),
    queryFn: () =>
      samplingApi.changes(api, {
        ...filters,
        status: filters.status ?? "PENDING",
        page: filters.page ?? 1,
        size: filters.size ?? 50,
      }),
    enabled,
  });
}
export function useSamplingMutation<TVariables>(
  mutationFn: (api: ReturnType<typeof useApiClient>, variables: TVariables) => Promise<unknown>,
) {
  const api = useApiClient();
  const cache = useQueryClient();
  return useMutation({
    mutationFn: (variables: TVariables) => mutationFn(api, variables),
    onSuccess: async () => {
      await Promise.all([
        cache.invalidateQueries({ queryKey: samplingKeys.all }),
        cache.invalidateQueries({ queryKey: changeRequestKeys.all }),
        // Phân công, mở lượt, chốt BM-02 và từ chối lấy mẫu đều làm đổi trạng thái hồ sơ.
        invalidateRequestRecords(cache),
      ]);
    },
  });
}
