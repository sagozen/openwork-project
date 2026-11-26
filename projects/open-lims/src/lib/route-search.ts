/**
 * TanStack Router giải mã giá trị query bằng JSON, nên mã toàn chữ số như `?code=26100001` về tới
 * `validateSearch` dưới dạng **number**, còn `?code=2610001201VO` mới là string. Bộ kiểm chỉ nhận
 * string sẽ âm thầm bỏ mã hồ sơ và màn hình rơi về trạng thái "chưa chọn hồ sơ" - dùng hàm này để
 * mọi route đọc mã theo cùng một cách.
 *
 * Đường đi trong ứng dụng (`<Link search={{ code }}>`) tự bọc nháy nên vẫn là string; hàm này lo
 * thêm cho URL người dùng gõ tay, bookmark hoặc dán cho nhau.
 */
export function searchString(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw.trim() || undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return undefined;
}
