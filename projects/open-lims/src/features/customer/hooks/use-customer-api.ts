import { useMemo } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createQueryKeys } from "@/lib/api";
import { useAuth } from "@/lib/auth/AuthProvider";
import { createCustomerApi } from "../api";
import type {
  CustomerListFilters,
  IssueInvoiceInput,
  PatchCustomerInput,
  RecordReceiptInput,
} from "../types";

export const customerLedgerKeys = createQueryKeys("debt-customers");
export const debtKeys = createQueryKeys("debt");

export function useCustomerApi() {
  const { getToken } = useAuth();
  return useMemo(() => createCustomerApi(getToken), [getToken]);
}

export function useCustomerList(filters: CustomerListFilters, enabled = true) {
  const api = useCustomerApi();
  return useQuery({
    queryKey: customerLedgerKeys.list(filters),
    queryFn: () => api.list(filters),
    enabled,
    // Giữ trang cũ khi đổi bộ lọc: không thì bảng nháy "không có khách hàng" giữa hai lần tải
    // và trông như bộ lọc không chạy.
    placeholderData: keepPreviousData,
  });
}

/** Sao kê một khách. Chỉ tải khi ngăn kéo mở - danh sách không cần tới nó. */
export function useCustomerStatement(id: string | null, enabled = true) {
  const api = useCustomerApi();
  return useQuery({
    queryKey: customerLedgerKeys.detail(id ?? ""),
    queryFn: () => api.statement(id as string),
    enabled: enabled && !!id,
  });
}

export function useDebtSummary(enabled = true) {
  const api = useCustomerApi();
  return useQuery({
    queryKey: [...debtKeys.all, "summary"],
    queryFn: () => api.summary(),
    enabled,
  });
}

/**
 * Mọi thao tác ghi đều dọn cả ba khoá: danh sách, sao kê của khách vừa đụng, và dải chỉ số.
 * Ghi một phiếu thu đổi số dư của khách đó, tổng công nợ toàn hệ và cả nhóm tuổi nợ của họ trong
 * bảng - làm mới thiếu một trong ba là để lại một con số cũ trên màn hình bên cạnh con số mới.
 */
function useLedgerMutation<TInput, TResult>(
  run: (input: TInput) => Promise<TResult>,
  customerIdOf: (input: TInput) => string | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (_result, input) => {
      queryClient.invalidateQueries({ queryKey: customerLedgerKeys.lists() });
      queryClient.invalidateQueries({ queryKey: [...debtKeys.all, "summary"] });
      const customerId = customerIdOf(input);
      if (customerId) {
        queryClient.invalidateQueries({ queryKey: customerLedgerKeys.detail(customerId) });
      }
    },
  });
}

export function usePatchCustomer() {
  const api = useCustomerApi();
  return useLedgerMutation(
    (input: { id: string; patch: PatchCustomerInput }) => api.patch(input.id, input.patch),
    (input) => input.id,
  );
}

export function useLockCustomer() {
  const api = useCustomerApi();
  return useLedgerMutation(
    (input: { id: string; reason: string; lock: boolean }) =>
      input.lock ? api.lock(input.id, input.reason) : api.unlock(input.id, input.reason),
    (input) => input.id,
  );
}

export function useIssueInvoice() {
  const api = useCustomerApi();
  return useLedgerMutation(
    (input: IssueInvoiceInput) => api.issueInvoice(input),
    (input) => input.customerId,
  );
}

export function useCancelInvoice(customerId?: string) {
  const api = useCustomerApi();
  return useLedgerMutation(
    (input: { id: string; reason: string }) => api.cancelInvoice(input.id, input.reason),
    () => customerId,
  );
}

export function useRecordReceipt() {
  const api = useCustomerApi();
  return useLedgerMutation(
    (input: RecordReceiptInput) => api.recordReceipt(input),
    (input) => input.customerId,
  );
}
