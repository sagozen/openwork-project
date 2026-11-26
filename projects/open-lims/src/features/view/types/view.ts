/* Chế độ xem đã lưu của màn Hồ sơ kiểm nghiệm (`/api/v1/me/views`).

   `definition` là CẤU TRÚC của giao diện (nhãn đã chọn, điều kiện lọc, thứ tự cột, cột ẩn, cột
   ghim, mật độ). Máy chủ giữ hộ và trả lại nguyên vẹn, không đọc vào bên trong - nên thêm một
   tuỳ chọn hiển thị mới KHÔNG cần đổi gì ở máy chủ. */

import type { Condition } from "@/lib/admin/records-view-data";

export type ViewScope = "private" | "branch" | "tenant";

/** Đúng phần state của màn được lưu lại. Cố ý KHÔNG có `savedViews`, `viewId`, `defaultViewId`:
 *  đó là danh sách chế độ xem, không phải nội dung của một chế độ xem. */
export interface SavedViewDefinition {
  tags: string[];
  tagMode: "any" | "all" | "none";
  conds: Condition[];
  order: string[];
  hidden: string[];
  pinned: string[];
  density: "comfortable" | "compact";
}

export interface SavedView {
  id: string;
  name: string;
  scope: ViewScope;
  isDefault: boolean;
  /** `false` với chế độ xem người khác chia sẻ: hiện ra được, nhưng không đổi tên/xoá được. */
  ownedByMe: boolean;
  definition?: SavedViewDefinition;
  updatedAt?: string;
}

export interface SavedViewListResponse {
  views: SavedView[];
}

export interface SaveViewInput {
  name?: string;
  scope?: ViewScope;
  isDefault?: boolean;
  definition?: SavedViewDefinition;
}
