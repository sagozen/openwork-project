import {
  formatAmount as formatMoney,
  formatDateTime,
  formatFileSize as formatBytes,
} from "@/lib/format";

/** Giữ tên cũ cho các màn hồ sơ đang gọi; định dạng thật nằm ở `@/lib/format` để mọi màn cùng
 *  một múi giờ và một cách viết. */
export const formatDate = formatDateTime;

/** Cùng lý do như `formatDate`: một cách viết số tiền duy nhất cho toàn sản phẩm (hồ sơ, thanh
 *  toán và công nợ khách hàng). */
export const formatAmount = formatMoney;

/** Cùng lý do như `formatDate`: một cách viết dung lượng duy nhất cho toàn sản phẩm, kể cả câu
 *  báo lỗi vượt trần tải lên. */
export const formatFileSize = formatBytes;
