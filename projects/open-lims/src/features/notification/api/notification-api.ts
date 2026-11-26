import type { ApiClient } from "@/lib/api";
import type { NotificationPage, NotificationQuery, UnreadCount } from "../types";

function query(filters: NotificationQuery): string {
  const params = new URLSearchParams();
  Object.entries(filters as Record<string, string | number | undefined>).forEach(([key, value]) => {
    if (value !== undefined && value !== "") params.set(key, String(value));
  });
  return params.size ? `?${params.toString()}` : "";
}

export const notificationApi = {
  list: (api: ApiClient, filters: NotificationQuery = {}) =>
    api.get<NotificationPage>(`/notifications${query(filters)}`),
  unreadCount: (api: ApiClient) => api.get<UnreadCount>("/notifications/unread-count"),
  // Cả hai đều trả về số chưa đọc SAU thay đổi, nên chuông vẽ lại từ con số của máy chủ chứ
  // không tự trừ đi một ở phía client.
  markRead: (api: ApiClient, id: string) =>
    api.post<UnreadCount>(`/notifications/${encodeURIComponent(id)}/read`),
  markAllRead: (api: ApiClient) => api.post<UnreadCount>("/notifications/read-all"),
};
