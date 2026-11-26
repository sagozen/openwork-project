import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, createQueryKeys, useApiClient } from "@/lib/api";
import { reportApi } from "../api";
import { invalidateRequestRecords } from "@/features/request";

export const reportKeys = createQueryKeys("reports");
export const deliveryKeys = createQueryKeys("report-deliveries");
export const supplementaryDocumentKeys = createQueryKeys("report-supplementary-documents");

export function useReportApi() {
  return useApiClient();
}

export function useReports(requestCode: string, enabled = true) {
  const api = useReportApi();
  return useQuery({
    queryKey: reportKeys.list({ requestCode }),
    queryFn: () => reportApi.list(api, requestCode),
    enabled: enabled && Boolean(requestCode),
  });
}

export function useSupplementaryDocumentReports(sampleCode: string) {
  const api = useReportApi();
  return useQuery({
    queryKey: reportKeys.list({ supplementaryDocumentSampleCode: sampleCode }),
    queryFn: () => reportApi.supplementaryDocumentReports(api, sampleCode),
    enabled: Boolean(sampleCode),
  });
}

export function useReport(reportId: string | undefined, enabled = true) {
  const api = useReportApi();
  return useQuery({
    queryKey: reportKeys.detail(reportId ?? ""),
    queryFn: () => reportApi.get(api, reportId!),
    enabled: enabled && Boolean(reportId),
  });
}

export function useReportRecipientContact(reportId: string | undefined, enabled = true) {
  const api = useReportApi();
  return useQuery({
    queryKey: reportKeys.detail(`${reportId ?? ""}:recipient-contact`),
    queryFn: () => reportApi.recipientContact(api, reportId!),
    enabled: enabled && Boolean(reportId),
  });
}

export function useReportDeliveries(reportId: string | undefined, enabled = true) {
  const api = useReportApi();
  return useQuery({
    queryKey: deliveryKeys.detail(reportId ?? ""),
    queryFn: () => reportApi.deliveries(api, reportId!),
    enabled: enabled && Boolean(reportId),
  });
}

export function useReportSupplementaryDocuments(
  reportId: string | undefined,
  enabled = true,
  forAddition = false,
) {
  const api = useReportApi();
  return useQuery({
    queryKey: supplementaryDocumentKeys.detail(reportId ?? ""),
    queryFn: () => reportApi.supplementaryDocuments(api, reportId!, forAddition),
    enabled: enabled && Boolean(reportId),
  });
}

export function useAddReportSupplementaryDocument() {
  const api = useReportApi();
  const cache = useQueryClient();
  return useMutation({
    mutationKey: supplementaryDocumentKeys.all,
    mutationFn: async ({ reportId, documentId }: { reportId: string; documentId: string }) => {
      try {
        return await reportApi.addSupplementaryDocument(api, reportId, { documentId });
      } catch (error) {
        // A committed append can lose its response. Confirm the exact link before treating a
        // duplicate retry as success; every other refusal remains an error.
        if (error instanceof ApiError && error.code === "E-RPT-017") {
          const documents = await reportApi.supplementaryDocuments(api, reportId, true);
          const linked = documents.items.find((document) => document.documentId === documentId);
          if (linked) return linked;
        }
        throw error;
      }
    },
    onSuccess: async (_, { reportId }) => {
      await cache.invalidateQueries({ queryKey: supplementaryDocumentKeys.detail(reportId) });
    },
  });
}

export function useReportMutation<TInput, TResult>(
  run: (api: ReturnType<typeof useApiClient>, input: TInput) => Promise<TResult>,
) {
  const api = useReportApi();
  const cache = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => run(api, input),
    onSuccess: async () => {
      await Promise.all([
        cache.invalidateQueries({ queryKey: reportKeys.all }),
        cache.invalidateQueries({ queryKey: deliveryKeys.all }),
        // Phát hành phiếu chuyển hồ sơ sang «Đã phát hành».
        invalidateRequestRecords(cache),
      ]);
    },
  });
}
