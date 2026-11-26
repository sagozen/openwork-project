/* Thông báo trong ứng dụng (`/api/v1/notifications`).
   Phân trang bằng CON TRỎ như nhật ký audit: danh sách mọc thêm ở đầu trong lúc người ta đang
   đọc, nên phân trang theo số trang sẽ đẩy một dòng qua ranh giới và hiện nó hai lần. */

export type NotificationCategory = "job" | "alert" | "system";

export interface AppNotification {
  id: string;
  category?: NotificationCategory;
  title: string;
  body?: string;
  /** Cùng từ vựng với `targetType` của nhật ký, để giải ra đường dẫn bằng một bảng tra duy nhất. */
  targetType?: string;
  targetId?: string;
  unread: boolean;
  readAt?: string;
  occurredAt: string;
}

export interface NotificationCursor {
  beforeOccurredAt: string;
  beforeId: string;
}

export interface NotificationPage {
  items: AppNotification[];
  pageSize: number;
  next?: NotificationCursor;
}

export interface UnreadCount {
  unread: number;
}

export interface NotificationQuery {
  category?: NotificationCategory;
  pageSize?: number;
  beforeOccurredAt?: string;
  beforeId?: string;
}
