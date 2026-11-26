import { createApiClient, type ApiClient, type TokenProvider } from "@/lib/api";
import type {
  CancelTestRequestInput,
  ConfirmPaymentInput,
  CreateCustomerInput,
  CreateTestRequestInput,
  CreateTestRequestResponse,
  CustomerDetail,
  CustomerSearchResponse,
  DraftTestRequest,
  PatchTestRequestInput,
  PaymentActionResponse,
  PaymentExceptionInput,
  RequestFilterOptions,
  RequestListFilters,
  RequestTagCatalog,
  RequestTagList,
  RequestListResponse,
  TestRequestDetail,
} from "../types/request";

function queryString(filters: RequestListFilters): string {
  const query = new URLSearchParams();
  const add = (key: string, value: unknown) => {
    if (value !== undefined && value !== "") query.append(key, String(value));
  };
  add("page", filters.page ?? 1);
  add("size", filters.size ?? 50);
  add("sort", filters.sort ?? "createdAt:desc");
  add("q", filters.q);
  add("tagMode", filters.tagMode);
  add("branchId", filters.branchId);
  add("fromDate", filters.fromDate);
  add("toDate", filters.toDate);
  // Backend binds these with `@QueryParam(...) List<String>`, which reads a repeated
  // `key=a&key=b`, not the `key[]=a&key[]=b` bracket convention (api-map.md: "lặp lại
  // tham số cho nhiều giá trị").
  for (const value of filters.status ?? []) add("status", value);
  for (const value of filters.paymentStatus ?? []) add("paymentStatus", value);
  for (const value of filters.tag ?? []) add("tag", value);
  return query.toString();
}

export function createRequestApi(tokenProvider: TokenProvider) {
  const api = createApiClient(tokenProvider);
  return createRequestApiWithClient(api);
}

export function createRequestApiWithClient(api: ApiClient) {
  return {
    list: (filters: RequestListFilters = {}) =>
      api.get<RequestListResponse>(`/test-requests?${queryString(filters)}`),
    detail: (code: string) =>
      api.get<TestRequestDetail>(`/test-requests/${encodeURIComponent(code)}`),
    // Từ vựng đóng cho thanh lọc S-01. Đường dẫn chữ nguyên văn, máy chủ khớp trước `/{code}`.
    filterOptions: () => api.get<RequestFilterOptions>("/test-requests/filter-options"),
    // Danh mục nhãn của cả đơn vị, kèm số dùng thật - KHÔNG suy từ các dòng đang tải.
    tagCatalog: () => api.get<RequestTagCatalog>("/request-tags"),
    attachTag: (code: string, tagCode: string) =>
      api.post<RequestTagList>(
        `/test-requests/${encodeURIComponent(code)}/tags/${encodeURIComponent(tagCode)}`,
      ),
    detachTag: (code: string, tagCode: string) =>
      api.del<RequestTagList>(
        `/test-requests/${encodeURIComponent(code)}/tags/${encodeURIComponent(tagCode)}`,
      ),
    // Draft rows carry no `code` (BR-003 only mints one once a request leaves DRAFT) - keyed by
    // internal `id` instead, to resume and prefill the create form.
    draft: (id: string) =>
      api.get<DraftTestRequest>(`/test-requests/drafts/${encodeURIComponent(id)}`),
    // Hai đường ghi đè lên CHÍNH dòng nháp cũ, thay vì tạo dòng mới. Trước đây cả hai nút của
    // màn tạo đều gọi `create`: «Lưu nháp» khi đang mở lại một nháp sinh ra nháp THỨ HAI, còn
    // «Hoàn tất tiếp nhận» sinh ra hồ sơ có mã và bỏ dòng nháp cũ ở lại DRAFT vĩnh viễn.
    saveDraft: (id: string, input: CreateTestRequestInput) =>
      api.patch<TestRequestDetail>(`/test-requests/drafts/${encodeURIComponent(id)}`, input),
    // Máy chủ cấp mã BR-003 rồi chuyển hồ sơ sang «Chờ phân công lấy mẫu», giữ nguyên id.
    submitDraft: (id: string, input: CreateTestRequestInput) =>
      api.post<TestRequestDetail>(`/test-requests/drafts/${encodeURIComponent(id)}/submit`, input),
    create: (input: CreateTestRequestInput) =>
      api.post<CreateTestRequestResponse>("/test-requests", input),
    patch: (code: string, input: PatchTestRequestInput) =>
      api.patch<TestRequestDetail>(`/test-requests/${encodeURIComponent(code)}`, input),
    cancel: (code: string, input: CancelTestRequestInput) =>
      api.post<TestRequestDetail>(`/test-requests/${encodeURIComponent(code)}/cancel`, input),
    // Both payment routes answer `{ payment: {...} }` (api-tests.md TC-25/TC-27), not the full
    // test-request detail envelope -- callers re-fetch the detail themselves after success.
    confirmPayment: (code: string, input: ConfirmPaymentInput) =>
      api.post<PaymentActionResponse>(`/test-requests/${encodeURIComponent(code)}/payment`, input),
    grantPaymentException: (code: string, input: PaymentExceptionInput) =>
      api.post<PaymentActionResponse>(
        `/test-requests/${encodeURIComponent(code)}/payment/exception`,
        input,
      ),
    customers: (q: string) =>
      api.get<CustomerSearchResponse>(`/customers?q=${encodeURIComponent(q)}`),
    createCustomer: (input: CreateCustomerInput) => api.post<CustomerDetail>("/customers", input),
  };
}
export type RequestApi = ReturnType<typeof createRequestApi>;
