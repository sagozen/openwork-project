/* Nhật ký audit đọc từ máy chủ.
   Hai route dùng CHUNG một hình dạng phản hồi (`AuditEventPageResponse`):
   - `GET /audit-events` - toàn hệ, cần quyền `audit.read`;
   - `GET /test-requests/{code}/audit-events` - lịch sử của một hồ sơ, cần `request.read`. */

/** Người thực hiện. `fullName` vắng mặt khi máy chủ không tiết lộ danh tính cho người gọi. */
export interface AuditActor {
  userId: string;
  fullName?: string;
}

export interface AuditEvent {
  id: string;
  occurredAt: string;
  actor?: AuditActor;
  action: string;
  targetType: string;
  targetId: string;
  traceId?: string;
  /** Máy chủ trả về một map tuỳ hành động, KHÔNG phải chuỗi dựng sẵn. Trường này vắng mặt là
   *  một quyết định phân quyền của máy chủ, không phải "sự kiện không có nội dung". */
  detail?: Record<string, unknown>;
}

/** Con trỏ trang kế tiếp. Vắng mặt nghĩa là đã hết dòng. */
export interface AuditCursor {
  beforeOccurredAt: string;
  beforeId: string;
}

export interface AuditEventPage {
  items: AuditEvent[];
  pageSize: number;
  next?: AuditCursor;
}

/** Bộ lọc của `GET /audit-events`. Máy chủ phân trang bằng CON TRỎ (`beforeOccurredAt` +
 *  `beforeId`), không phải `page`/`size` như các danh sách khác. */
export interface AuditQuery {
  actorUserId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  /** ISO 8601. */
  from?: string;
  to?: string;
  pageSize?: number;
  beforeOccurredAt?: string;
  beforeId?: string;
}
