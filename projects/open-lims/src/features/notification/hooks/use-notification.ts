import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createQueryKeys, useApiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth/AuthProvider";
import { notificationApi } from "../api";
import type { NotificationCategory, NotificationCursor, NotificationPage } from "../types";

export const notificationKeys = createQueryKeys("notifications");

/** Số chưa đọc: khoá riêng khỏi danh sách vì chuông đọc nó ở MỌI màn, còn danh sách chỉ tải khi
 *  người dùng mở ngăn kéo. */
const unreadKey = ["notifications", "unread-count"] as const;

function nextCursor(page: NotificationPage): NotificationCursor | undefined {
  return page.next?.beforeId ? page.next : undefined;
}

/** Chuông. Chỉ chạy ở chế độ thật - bản minh hoạ không có máy chủ nào để hỏi. */
export function useUnreadNotificationCount() {
  const api = useApiClient();
  const { usesClerk, isSignedIn } = useAuth();
  return useQuery({
    queryKey: unreadKey,
    queryFn: () => notificationApi.unreadCount(api),
    enabled: usesClerk && isSignedIn,
    // Thông báo tới từ việc người KHÁC làm, nên không có mutation nào ở máy này để dọn bộ nhớ
    // đệm. Hỏi lại theo nhịp là cách duy nhất chuông tự sáng lên mà không cần tải lại trang.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useNotifications(category?: NotificationCategory, enabled = true) {
  const api = useApiClient();
  const { usesClerk } = useAuth();
  return useInfiniteQuery({
    queryKey: notificationKeys.list({ category: category ?? null }),
    queryFn: ({ pageParam }) =>
      notificationApi.list(api, { ...(category ? { category } : {}), ...(pageParam ?? {}) }),
    initialPageParam: undefined as NotificationCursor | undefined,
    getNextPageParam: nextCursor,
    enabled: enabled && usesClerk,
  });
}

/** Đánh dấu đã đọc. Máy chủ trả lại số chưa đọc mới, ghi thẳng vào bộ nhớ đệm của chuông thay vì
 *  gọi thêm một vòng nữa chỉ để hỏi con số vừa được cho biết. */
export function useMarkNotificationRead() {
  const api = useApiClient();
  const cache = useQueryClient();
  return useMutation({
    mutationFn: (id?: string) =>
      id ? notificationApi.markRead(api, id) : notificationApi.markAllRead(api),
    onSuccess: (result) => {
      cache.setQueryData(unreadKey, result);
      void cache.invalidateQueries({ queryKey: notificationKeys.lists() });
    },
  });
}
