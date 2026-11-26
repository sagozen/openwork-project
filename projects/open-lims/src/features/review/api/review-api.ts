import type { ApiClient } from "@/lib/api";
import type {
  QuickConfirmItem,
  QuickConfirmResponse,
  ResultVersionHistory,
  ReviewFilters,
  TechnicalReviewDetail,
  TechnicalReviewList,
} from "../types";

/** List filters use repeated `status=A&status=B`, matching the technical review API. */
function query(filters: object): string {
  const params = new URLSearchParams();
  Object.entries(filters as Record<string, string | string[] | number | undefined>).forEach(
    ([key, value]) => {
      if (Array.isArray(value)) value.forEach((entry) => params.append(key, entry));
      else if (value !== undefined && value !== "") params.set(key, String(value));
    },
  );
  return params.size ? `?${params.toString()}` : "";
}
const taskPath = (code: string) => `/analysis-tasks/${encodeURIComponent(code)}`;

export const reviewApi = {
  technicalQueue: (api: ApiClient, filters: ReviewFilters = {}) =>
    api.get<TechnicalReviewList>(`/technical-reviews${query(filters)}`),
  technicalDetail: (api: ApiClient, code: string) =>
    api.get<TechnicalReviewDetail>(`${taskPath(code)}/review`),
  resultVersions: (api: ApiClient, code: string) =>
    api.get<ResultVersionHistory>(`${taskPath(code)}/result-versions`),
  decideTechnical: (
    api: ApiClient,
    code: string,
    input: { decision: "ACCEPT" | "RETURN"; comment?: string; version: number },
  ) => api.post<TechnicalReviewDetail>(`${taskPath(code)}/technical-review`, input),
  quickConfirm: (api: ApiClient, items: QuickConfirmItem[], note = "") =>
    api.post<QuickConfirmResponse>("/technical-reviews/quick-confirm", { items, note }),
};
