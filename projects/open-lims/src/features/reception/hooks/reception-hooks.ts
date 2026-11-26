import {
  keepPreviousData,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { createQueryKeys, useApiClient } from "@/lib/api";
import { createReceptionApi } from "../api";
import type {
  CreatePrintJobInput,
  PrintJob,
  ReceptionFilters,
  RecordReceptionInput,
  RetryPrintJobInput,
  SplitSampleInput,
} from "../types";
import { labKeys } from "@/features/lab/hooks";
import { invalidateRequestRecords } from "@/features/request";

export const receptionKeys = createQueryKeys("reception");
export const handoverContextKeys = createQueryKeys("handover-context");
export const printJobKeys = createQueryKeys("reception-print-job");
export const sampleKeys = createQueryKeys("reception-sample");
export const counterpartKeys = createQueryKeys("reception-counterpart");

export function useReceptionApi() {
  const client = useApiClient();
  return useMemo(() => createReceptionApi(client), [client]);
}

/** Danh bạ hẹp cho ô «người giao/nhận đối ứng». `staleTime` dài: nhân sự chi nhánh gần như không
 *  đổi trong một phiên làm việc, và mỗi lần mở thẻ bàn giao mà gọi lại là lãng phí. */
export function useHandoverCounterparts(enabled: boolean) {
  const api = useReceptionApi();
  return useQuery({
    queryKey: counterpartKeys.list({}),
    queryFn: () => api.handoverCounterparts(),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useReceptionWorklist(filters: ReceptionFilters, enabled: boolean) {
  const api = useReceptionApi();
  return useQuery({
    queryKey: receptionKeys.list(filters),
    queryFn: () => api.list(filters),
    enabled,
    staleTime: 15_000,
    /* Đổi bộ lọc thì giữ nguyên hàng chờ cũ cho tới khi có hàng chờ mới. Không có nó, mỗi lần
       người dùng chạm vào ô tìm kiếm hay ô trạng thái là màn rơi về `isPending` và dựng lại từ
       đầu — kể cả ô đang gõ. */
    placeholderData: keepPreviousData,
  });
}

export function useReceptionDetail(
  requestCode: string | undefined,
  enabled: boolean,
  sampleCode?: string,
) {
  const api = useReceptionApi();
  return useQuery({
    queryKey: [...receptionKeys.detail(requestCode ?? ""), sampleCode ?? ""],
    queryFn: () => api.detail(requestCode!, sampleCode),
    enabled: enabled && !!requestCode,
  });
}

export function useHandoverContext(scanCode: string | undefined, enabled: boolean) {
  const api = useReceptionApi();
  return useQuery({
    queryKey: handoverContextKeys.detail(scanCode ?? ""),
    queryFn: () => api.handoverContext(scanCode!),
    enabled: enabled && !!scanCode,
  });
}

export function useRecordReception(requestCode: string | undefined) {
  const api = useReceptionApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RecordReceptionInput) => api.record(requestCode!, input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: receptionKeys.all }),
        queryClient.invalidateQueries({ queryKey: receptionKeys.detail(requestCode ?? "") }),
        // Tạm giữ và từ chối tiếp nhận chuyển hồ sơ sang «Tạm giữ»/«Từ chối tiếp nhận».
        invalidateRequestRecords(queryClient),
      ]);
    },
  });
}

/** Mẫu cha + danh sách mẫu con/task đọc lại từ máy chủ. `useSplitSample` chỉ trả kết quả một
 *  lần, ngay lúc chia; sau khi tải lại trang chỉ còn đường này biết mẫu con nào tồn tại, nên tem
 *  mẫu con in lại được thay vì biến mất cùng state React. */
export function useSampleDetail(sampleCode: string | undefined, enabled: boolean) {
  const api = useReceptionApi();
  return useQuery({
    queryKey: sampleKeys.detail(sampleCode ?? ""),
    queryFn: () => api.sample(sampleCode!),
    enabled: enabled && !!sampleCode,
  });
}

export function useSplitSample(sampleCode: string | undefined) {
  const api = useReceptionApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SplitSampleInput) => api.split(sampleCode!, input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: receptionKeys.all }),
        queryClient.invalidateQueries({ queryKey: sampleKeys.detail(sampleCode ?? "") }),
        queryClient.invalidateQueries({ queryKey: handoverContextKeys.all }),
        /* Split is the only writer of analysis tasks (FR-RCV-015). /cong-viec reads labKeys. */
        queryClient.invalidateQueries({ queryKey: labKeys.all }),
      ]);
    },
  });
}

export function useCreatePrintJob(sampleCode: string | undefined) {
  const api = useReceptionApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePrintJobInput) => api.createPrintJob(sampleCode!, input),
    onSuccess: (job) => queryClient.setQueryData(printJobKeys.detail(job.id), job),
  });
}

export function useRetryPrintJob() {
  const api = useReceptionApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, input }: { jobId: string; input: RetryPrintJobInput }) =>
      api.retryPrintJob(jobId, input),
    onSuccess: (job) => queryClient.setQueryData(printJobKeys.detail(job.id), job),
  });
}

const TERMINAL_PRINT_STATES = new Set(["CONFIRMED", "FAILED", "CANCELLED", "UNKNOWN"]);

export function usePrintJobPolling(jobIds: string[], enabled: boolean): PrintJob[] {
  const api = useReceptionApi();
  const results = useQueries({
    queries: jobIds.map((jobId) => ({
      queryKey: printJobKeys.detail(jobId),
      queryFn: () => api.printJob(jobId),
      enabled,
      refetchInterval: (query: { state: { data?: PrintJob; dataUpdateCount: number } }) => {
        const job = query.state.data;
        if (job && TERMINAL_PRINT_STATES.has(job.status.code)) return false;
        return query.state.dataUpdateCount >= 8 ? false : 2_000;
      },
    })),
  });
  return results.flatMap((result) => (result.data ? [result.data] : []));
}
