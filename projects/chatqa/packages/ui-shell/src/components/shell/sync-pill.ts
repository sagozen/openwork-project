// Chữ trên pill đồng bộ của thanh tiêu đề cho sản phẩm chưa có Drive công ty (sản phẩm có Drive dùng SyncBadge thay pill).
// Thứ tự ưu tiên giữ như cũ: mất mạng > cần đăng nhập lại > mục lỗi/xung đột > còn chờ > đã đồng bộ.
export interface SyncPillFacts {
  offline: boolean;
  /** Số ngày đã dùng offline (máy đã quá hạn xác thực), chỉ để viết rõ hơn câu "Mất kết nối". */
  offlineDays?: number;
  needsLogin?: boolean;
  failed?: number;
  conflict?: number;
  syncing?: boolean;
  pending?: number;
}

/**
 * Câu trên pill; null = không hiện pill (sản phẩm không có hàng đợi đồng bộ, hoặc đang rảnh và sản phẩm không có
 * câu "đã đồng bộ" riêng). Truyền `doneLabel` của sản phẩm (vd "Đã đồng bộ Google Drive").
 */
export function syncPillText(f: SyncPillFacts, doneLabel: string | null): string | null {
  if (f.offline) return (f.offlineDays ?? 0) > 0 ? `Mất kết nối · ${f.offlineDays} ngày` : 'Mất kết nối';
  if (f.needsLogin) return 'Cần đăng nhập lại để đồng bộ';
  const issues = (f.failed ?? 0) + (f.conflict ?? 0);
  if (issues > 0) return `${issues} mục cần xử lý`;
  if (f.syncing || (f.pending ?? 0) > 0) return `Chưa đồng bộ: ${f.pending ?? 0}`;
  return doneLabel;
}
