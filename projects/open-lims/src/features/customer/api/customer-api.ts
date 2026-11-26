import { createApiClient, type ApiClient, type TokenProvider } from "@/lib/api";
import type {
  CustomerInvoice,
  CustomerListFilters,
  CustomerListResponse,
  CustomerLedgerRow,
  CustomerReceipt,
  CustomerStatement,
  DebtSummary,
  IssueInvoiceInput,
  PatchCustomerInput,
  RecordReceiptInput,
} from "../types";

function queryString(filters: CustomerListFilters): string {
  const query = new URLSearchParams();
  const add = (key: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== "") {
      query.append(key, String(value));
    }
  };
  add("q", filters.q);
  add("branchId", filters.branchId);
  add("status", filters.status);
  add("bucket", filters.bucket);
  add("page", filters.page ?? 1);
  add("size", filters.size ?? 20);
  return query.toString();
}

export function createCustomerApi(tokenProvider: TokenProvider) {
  return createCustomerApiWithClient(createApiClient(tokenProvider));
}

export function createCustomerApiWithClient(api: ApiClient) {
  return {
    /** Danh sách kèm công nợ mỗi khách. Khác `/customers?q=` của form hồ sơ - cái đó là ô gợi ý
     *  20 dòng, cái này là sổ có phân trang và bộ lọc. */
    list: (filters: CustomerListFilters = {}) =>
      api.get<CustomerListResponse>(`/debt/customers?${queryString(filters)}`),
    statement: (id: string) =>
      api.get<CustomerStatement>(`/debt/customers/${encodeURIComponent(id)}`),
    patch: (id: string, input: PatchCustomerInput) =>
      api.patch<CustomerLedgerRow>(`/debt/customers/${encodeURIComponent(id)}`, input),
    lock: (id: string, reason: string) =>
      api.post<CustomerLedgerRow>(`/debt/customers/${encodeURIComponent(id)}/lock`, { reason }),
    unlock: (id: string, reason?: string) =>
      api.post<CustomerLedgerRow>(`/debt/customers/${encodeURIComponent(id)}/unlock`, { reason }),

    summary: () => api.get<DebtSummary>("/debt/summary"),
    invoices: (customerId?: string) =>
      api.get<{ data: CustomerInvoice[] }>(
        `/debt/invoices${customerId ? `?customerId=${encodeURIComponent(customerId)}` : ""}`,
      ),
    issueInvoice: (input: IssueInvoiceInput) => api.post<CustomerInvoice>("/debt/invoices", input),
    cancelInvoice: (id: string, reason: string) =>
      api.post<CustomerInvoice>(`/debt/invoices/${encodeURIComponent(id)}/cancel`, { reason }),
    recordReceipt: (input: RecordReceiptInput) =>
      api.post<CustomerReceipt>("/debt/receipts", input),
  };
}

export type CustomerApi = ReturnType<typeof createCustomerApiWithClient>;
