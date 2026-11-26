/** Tiền VND dùng dấu phẩy phân cách hàng nghìn và dấu chấm thập phân,
 *  thống nhất giữa ô nhập, hồ sơ thanh toán và công nợ khách hàng. */
const FORMATTER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** Số tiền đầy đủ: `4200000.5` → `4,200,000.5 ₫`. Giá trị trống trả chuỗi rỗng thay vì `0 ₫` -
 *  "chưa có số" và "bằng không" là hai chuyện khác nhau trên màn công nợ. */
export function formatAmount(value?: number | null): string {
  if (value === undefined || value === null) return "";
  return `${FORMATTER.format(value)} ₫`;
}

/** Giữ phần thập phân, kể cả dấu chấm/đuôi 0 đang gõ, và chỉ nhóm phần nguyên. */
export function formatVndInput(value: string): string {
  const normalized = value.replace(/[^\d.]/g, "");
  const decimalIndex = normalized.indexOf(".");
  const integer = (decimalIndex < 0 ? normalized : normalized.slice(0, decimalIndex)).replace(
    /^0+(?=\d)/,
    "",
  );
  const fraction = decimalIndex < 0 ? "" : normalized.slice(decimalIndex);
  const grouped = (integer || (fraction ? "0" : "")).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return grouped + fraction;
}

/** Giá trị gửi API; chỉ chấp nhận số thập phân không âm, có thể kèm nhóm nghìn và ký hiệu ₫. */
export function parseVndInput(value: string): number {
  const normalized = value.trim().replace(/\s*₫$/, "").replace(/,/g, "");
  return /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized) ? Number(normalized) : NaN;
}
