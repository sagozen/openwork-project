import type { ApiClient } from "@/lib/api";
import type {
  CreatePrintJobInput,
  PrintJob,
  ReceptionDetail,
  ReceptionFilters,
  HandoverContextResponse,
  HandoverCounterpart,
  ReceptionWorklist,
  RecordReceptionInput,
  RecordReceptionResult,
  RetryPrintJobInput,
  SampleDetail,
  SplitSampleInput,
  SplitSampleResult,
} from "../types/reception";

function queryString(filters: ReceptionFilters): string {
  const params = new URLSearchParams();
  if (filters.page !== undefined) params.set("page", String(filters.page));
  if (filters.size !== undefined) params.set("size", String(filters.size));
  if (filters.sort) params.set("sort", filters.sort);
  if (filters.q) params.set("q", filters.q);
  // Backend @QueryParam("status") List<String> (ReceptionResource#queue) đọc chuỗi lặp
  // "status=A&status=B" - không phải "status[]"; api-map.md ghi "status[]" nhưng controller
  // thật (ground truth) mới là chuẩn để FE gửi đúng, nếu không server bỏ qua bộ lọc.
  filters.status?.forEach((status) => params.append("status", status));
  if (filters.branchId) params.set("branchId", filters.branchId);
  if (filters.fromDate) params.set("fromDate", filters.fromDate);
  if (filters.toDate) params.set("toDate", filters.toDate);
  const value = params.toString();
  return value ? `?${value}` : "";
}

export function createReceptionApi(api: ApiClient) {
  return {
    list: (filters: ReceptionFilters = {}) =>
      api.get<ReceptionWorklist>(`/receptions${queryString(filters)}`),
    detail: (requestCode: string, sampleCode?: string) =>
      api.get<ReceptionDetail>(
        `/test-requests/${encodeURIComponent(requestCode)}/reception${sampleCode ? `?sampleCode=${encodeURIComponent(sampleCode)}` : ""}`,
      ),
    /** The server resolves request, parent, and sub-sample labels. Never infer an owning request
     * from a label suffix in the browser: label formats are not an authorization boundary. */
    handoverContext: (scanCode: string) =>
      api.get<HandoverContextResponse>(
        `/test-requests/handover-context/resolve?scanCode=${encodeURIComponent(scanCode)}`,
      ),
    record: (requestCode: string, input: RecordReceptionInput) =>
      api.post<RecordReceptionResult>(
        `/test-requests/${encodeURIComponent(requestCode)}/reception`,
        input,
      ),
    sample: (sampleCode: string) =>
      api.get<SampleDetail>(`/samples/${encodeURIComponent(sampleCode)}`),
    split: (sampleCode: string, input: SplitSampleInput) =>
      api.post<SplitSampleResult>(`/samples/${encodeURIComponent(sampleCode)}/split`, input),
    createPrintJob: (sampleCode: string, input: CreatePrintJobInput) =>
      api.post<PrintJob>(`/samples/${encodeURIComponent(sampleCode)}/label-print-jobs`, input),
    printJob: (jobId: string) =>
      api.get<PrintJob>(`/label-print-jobs/${encodeURIComponent(jobId)}`),
    retryPrintJob: (jobId: string, input: RetryPrintJobInput) =>
      api.post<PrintJob>(`/label-print-jobs/${encodeURIComponent(jobId)}/retry`, input),
    handoverCounterparts: () =>
      api.get<{ content: HandoverCounterpart[] }>("/handovers/counterparts"),
  };
}

export type ReceptionApi = ReturnType<typeof createReceptionApi>;
