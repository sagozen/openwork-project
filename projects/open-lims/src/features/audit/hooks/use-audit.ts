import { useInfiniteQuery } from "@tanstack/react-query";
import { createQueryKeys, useApiClient } from "@/lib/api";
import { auditApi } from "../api";
import type { AuditCursor, AuditEvent, AuditEventPage, AuditQuery } from "../types";

export const auditKeys = createQueryKeys("audit-events");

const DEFAULT_PAGE_SIZE = 50;

/** Con trỏ của trang kế: máy chủ trả `next` khi còn dòng, bỏ trống khi đã hết. */
function nextCursor(page: AuditEventPage): AuditCursor | undefined {
  return page.next?.beforeId ? page.next : undefined;
}

/** Nối các trang của `useInfiniteQuery` thành một danh sách phẳng, giữ nguyên thứ tự máy chủ
 *  trả về (`occurred_at DESC, id DESC`). Chưa tải trang nào thì là danh sách rỗng chứ không
 *  phải `undefined`, để chỗ gọi không phải tự phòng thủ. */
export function flattenAuditPages(pages?: AuditEventPage[]): AuditEvent[] {
  return pages?.flatMap((page) => page.items) ?? [];
}

/** Nhật ký toàn hệ. Dùng `useInfiniteQuery` vì máy chủ phân trang bằng con trỏ giữ-chỗ
 *  (`occurred_at DESC, id DESC`) - không nhảy tới trang N được, chỉ "tải thêm" nối tiếp. */
export function useAuditEvents(filters: AuditQuery, enabled = true) {
  const api = useApiClient();
  return useInfiniteQuery({
    queryKey: auditKeys.list(filters),
    queryFn: ({ pageParam }) =>
      auditApi.search(api, {
        ...filters,
        pageSize: filters.pageSize ?? DEFAULT_PAGE_SIZE,
        ...(pageParam ?? {}),
      }),
    initialPageParam: undefined as AuditCursor | undefined,
    getNextPageParam: nextCursor,
    enabled,
  });
}

/** Lịch sử của một hồ sơ. */
export function useRequestAuditEvents(code?: string, enabled = true) {
  const api = useApiClient();
  return useInfiniteQuery({
    queryKey: auditKeys.detail(code ?? ""),
    queryFn: ({ pageParam }) =>
      auditApi.forRequest(api, code!, { pageSize: DEFAULT_PAGE_SIZE, ...(pageParam ?? {}) }),
    initialPageParam: undefined as AuditCursor | undefined,
    getNextPageParam: nextCursor,
    enabled: enabled && !!code,
  });
}
