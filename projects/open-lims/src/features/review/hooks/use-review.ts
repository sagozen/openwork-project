import { useQuery } from "@tanstack/react-query";
import { createQueryKeys, useApiClient } from "@/lib/api";
import { reviewApi } from "../api";
import type { ReviewFilters } from "../types";

export const technicalReviewKeys = createQueryKeys("technical-reviews");
export function useTechnicalReviews(filters: ReviewFilters, enabled = true) {
  const api = useApiClient();
  return useQuery({
    queryKey: technicalReviewKeys.list(filters),
    queryFn: () => reviewApi.technicalQueue(api, filters),
    enabled,
  });
}
export function useTechnicalReview(code?: string, enabled = true) {
  const api = useApiClient();
  return useQuery({
    queryKey: technicalReviewKeys.detail(code ?? ""),
    queryFn: () => reviewApi.technicalDetail(api, code!),
    enabled: enabled && !!code,
  });
}
export function useResultVersions(code?: string, enabled = true) {
  const api = useApiClient();
  return useQuery({
    queryKey: ["result-versions", code],
    queryFn: () => reviewApi.resultVersions(api, code!),
    enabled: enabled && !!code,
    staleTime: 0,
  });
}
