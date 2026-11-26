import type { ApiClient } from "@/lib/api";
import type { AuditEventPage, AuditQuery } from "../types";

/** Cùng quy ước với các client khác: tham số lặp lại cho nhiều giá trị, bỏ qua giá trị rỗng.
 *  Nhật ký hiện không có tham số nhiều giá trị nào, nhưng giữ chung một hàm để khi máy chủ thêm
 *  (vd lọc nhiều `action` cùng lúc) thì không phải viết lại chỗ nối chuỗi. */
function query(filters: AuditQuery): string {
  const params = new URLSearchParams();
  Object.entries(filters as Record<string, string | number | undefined>).forEach(([key, value]) => {
    if (value !== undefined && value !== "") params.set(key, String(value));
  });
  return params.size ? `?${params.toString()}` : "";
}

export const auditApi = {
  /** Nhật ký toàn hệ (`audit.read`). */
  search: (api: ApiClient, filters: AuditQuery = {}) =>
    api.get<AuditEventPage>(`/audit-events${query(filters)}`),

  /** Lịch sử của một hồ sơ (`request.read`). Chỉ nhận tham số phân trang. */
  forRequest: (
    api: ApiClient,
    code: string,
    cursor: Pick<AuditQuery, "pageSize" | "beforeOccurredAt" | "beforeId"> = {},
  ) =>
    api.get<AuditEventPage>(
      `/test-requests/${encodeURIComponent(code)}/audit-events${query(cursor)}`,
    ),
};
