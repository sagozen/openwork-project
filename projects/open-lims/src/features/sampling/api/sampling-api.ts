import type { ApiClient, StatusValue } from "@/lib/api";
import type {
  ApprovalInput,
  AssignmentInput,
  Bm02Input,
  Bm02Result,
  Bm03Input,
  Bm03Result,
  ChangeRequestInput,
  FieldChangeRequest,
  OpenInput,
  ReconciliationInput,
  ReconciliationResult,
  Sampler,
  SamplingAssignment,
  SamplingAssignmentDetail,
  ServerPage,
} from "../types";

// Backend binds list query params qua @QueryParam(...) List<String> - cần lặp lại cùng tên
// (vd. status=A&status=B), KHÔNG dùng hậu tố `[]` (RESTEasy Reactive không nhận diện được).
const query = (values: Record<string, string | number | string[] | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) value.forEach((item) => params.append(key, item));
    else if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
};
export const samplingApi = {
  samplers: (api: ApiClient, filters: { date?: string; branchId?: string } = {}) =>
    api.get<{ content: Sampler[] }>(`/samplers${query(filters)}`),
  assign: (api: ApiClient, code: string, input: AssignmentInput) =>
    api.post<{ assignmentCode: string; status: StatusValue }>(
      `/test-requests/${encodeURIComponent(code)}/sampling-assignment`,
      input,
    ),
  assignments: (
    api: ApiClient,
    filters: { date?: string; status?: string[]; page?: number; size?: number } = {},
  ) => api.get<ServerPage<SamplingAssignment>>(`/sampling-assignments${query(filters)}`),
  resolve: (api: ApiClient, sampleCode: string) =>
    api.get<{ assignmentCode: string; requestCode: string; sampleCode: string }>(
      `/sampling-assignments/resolve?sampleCode=${encodeURIComponent(sampleCode)}`,
    ),
  detail: (api: ApiClient, code: string) =>
    api.get<SamplingAssignmentDetail>(`/sampling-assignments/${encodeURIComponent(code)}`),
  open: (api: ApiClient, code: string, input: OpenInput) =>
    api.post<SamplingAssignment>(`/sampling-assignments/${encodeURIComponent(code)}/open`, input),
  /* Đối soát là lời gọi ngắn, không kèm tệp, và có Idempotency-Key nên bấm lại an toàn. Đặt hạn
     chờ để nút không kẹt ở "Đang gửi…" mà không nói gì khi mạng hiện trường chập chờn. */
  reconcile: (api: ApiClient, code: string, input: ReconciliationInput) =>
    api.post<ReconciliationResult>(
      `/sampling-assignments/${encodeURIComponent(code)}/reconciliation`,
      input,
      { timeoutMs: 20_000 },
    ),
  requestChange: (api: ApiClient, code: string, input: ChangeRequestInput) =>
    api.post<FieldChangeRequest>(
      `/sampling-assignments/${encodeURIComponent(code)}/change-requests`,
      input,
    ),
  rejectSampling: (api: ApiClient, code: string, reason: string, attachmentIds: string[]) =>
    api.post<SamplingAssignment>(
      `/sampling-assignments/${encodeURIComponent(code)}/reject-sampling`,
      { reason, attachmentIds },
    ),
  bm03: (api: ApiClient, code: string, input: Bm03Input) =>
    api.post<Bm03Result>(`/sampling-assignments/${encodeURIComponent(code)}/bm03`, input),
  bm02: (api: ApiClient, code: string, input: Bm02Input) =>
    api.post<Bm02Result>(`/sampling-assignments/${encodeURIComponent(code)}/bm02`, input),
  changes: (
    api: ApiClient,
    filters: { status?: string; branchId?: string; page?: number; size?: number } = {},
  ) => api.get<ServerPage<FieldChangeRequest>>(`/field-change-requests${query(filters)}`),
  approve: (api: ApiClient, id: string, input: ApprovalInput) =>
    api.post<FieldChangeRequest>(`/field-change-requests/${encodeURIComponent(id)}/approve`, input),
  rejectChange: (api: ApiClient, id: string, reason: string) =>
    api.post<FieldChangeRequest>(`/field-change-requests/${encodeURIComponent(id)}/reject`, {
      reason,
    }),
};
