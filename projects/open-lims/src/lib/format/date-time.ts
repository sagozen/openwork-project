/** Múi giờ hiển thị của sản phẩm. Cố định, không lấy theo máy người dùng: phiếu, giờ đo và dấu
 *  vết kiểm toán đều là dữ liệu vận hành của phòng thử nghiệm ở Việt Nam, nên một máy đặt sai
 *  múi giờ không được phép làm hai người đọc cùng một bản ghi ra hai giờ khác nhau. */
export const DISPLAY_TIME_ZONE = "Asia/Ho_Chi_Minh";

const FORMATTER = new Intl.DateTimeFormat("vi-VN", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: DISPLAY_TIME_ZONE,
});

/**
 * Đổi mốc thời gian ISO của máy chủ (luôn UTC, ví dụ `2026-08-28T03:19:00Z`) sang giờ người dùng
 * đọc được (`28/08/2026 10:19`).
 *
 * Máy chủ trả ISO-UTC là đúng; in thẳng chuỗi đó ra màn hình mới là sai — vừa là định dạng máy,
 * vừa lệch 7 tiếng so với con số người vận hành vừa gõ vào, khiến họ tưởng hệ thống ghi nhầm.
 *
 * Chuỗi không phân giải được thì trả nguyên văn, KHÔNG in "Invalid Date": mất định dạng còn hơn
 * mất dữ liệu trước mắt người đọc.
 */
export function formatDateTime(value?: string | null): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : FORMATTER.format(parsed);
}

/**
 * Giờ trong ngày, bỏ phần giây: `08:00:00` → `08:00`.
 *
 * Máy chủ trả cột `time` đầy đủ, còn lịch hẹn lấy mẫu thì đặt theo phút - in ra giây làm người
 * đọc tưởng hệ thống đòi chính xác tới giây. Chuỗi không đúng dạng giờ thì trả nguyên văn.
 */
export function formatClock(value?: string | null): string {
  if (!value) return "";
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?/.exec(value.trim());
  return match ? `${match[1]!.padStart(2, "0")}:${match[2]}` : value;
}
