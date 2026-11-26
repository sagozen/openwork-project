import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createQueryKeys } from "@/lib/api";
import { useAuth } from "@/lib/auth/AuthProvider";
import { createRequestApi } from "../api";
import type { RequestListFilters } from "../types";

export const requestKeys = createQueryKeys("test-requests");

/**
 * Đánh dấu danh sách và chi tiết hồ sơ là đã cũ, gọi từ BẤT KỲ khâu nào làm đổi trạng thái hồ sơ.
 *
 * `ops.test_request.status` được nhiều khâu ghi: phân công/mở lượt/chốt BM-02 (lấy mẫu), quyết
 * định tại quầy và bàn giao (tiếp nhận), duyệt kỹ thuật và duyệt lãnh đạo, phát hành phiếu. Mỗi
 * khâu trước đây chỉ dọn bộ nhớ đệm CỦA MÌNH, nên màn Hồ sơ kiểm nghiệm đang mở vẫn hiện trạng
 * thái trước đó - và vì `refetchOnWindowFocus` đang tắt, nó đứng yên cho tới khi người dùng rời
 * màn rồi quay lại.
 *
 * Để ở đây, cạnh chính khoá nó dọn, thay vì lặp lại lời giải thích trong từng feature.
 */
export function invalidateRequestRecords(cache: QueryClient) {
  return cache.invalidateQueries({ queryKey: requestKeys.all });
}
export const customerKeys = createQueryKeys("customers");
export const requestTagKeys = createQueryKeys("request-tags");
export function useRequestApi() {
  const { getToken } = useAuth();
  return useMemo(() => createRequestApi(getToken), [getToken]);
}
export function useRequestList(filters: RequestListFilters, enabled = true) {
  const api = useRequestApi();
  return useQuery({
    queryKey: requestKeys.list(filters),
    queryFn: () => api.list(filters),
    enabled,
  });
}
/** Từ vựng của thanh lọc. Đổi rất hiếm nên giữ lâu trong bộ nhớ đệm thay vì hỏi lại mỗi lần mở
 *  ngăn lọc; và không có nó thì cũng không chặn màn hình - chỗ gọi tự lo trạng thái rỗng. */
export function useRequestFilterOptions(enabled = true) {
  const api = useRequestApi();
  return useQuery({
    queryKey: ["test-requests", "filter-options"],
    queryFn: () => api.filterOptions(),
    staleTime: 30 * 60 * 1000,
    enabled,
  });
}
/** Danh mục nhãn. Đổi hiếm, nhưng số dùng thì đổi theo mỗi lần gắn/gỡ - nên vẫn cho hết hạn
 *  nhanh hơn `filter-options`, và các mutation nhãn tự dọn khoá này. */
export function useRequestTags(enabled = true) {
  const api = useRequestApi();
  return useQuery({
    queryKey: requestTagKeys.lists(),
    queryFn: () => api.tagCatalog(),
    staleTime: 5 * 60 * 1000,
    enabled,
  });
}
export function useRequestDetail(code: string, enabled = true) {
  const api = useRequestApi();
  return useQuery({
    queryKey: requestKeys.detail(code),
    queryFn: () => api.detail(code),
    enabled: enabled && !!code,
  });
}
export function useRequestMutation<TInput, TResult>(
  run: (api: ReturnType<typeof createRequestApi>, input: TInput) => Promise<TResult>,
) {
  const api = useRequestApi();
  const cache = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => run(api, input),
    onSuccess: () => cache.invalidateQueries({ queryKey: requestKeys.all }),
  });
}
