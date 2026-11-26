/**
 * Link tra cứu công khai gửi cho khách hàng (cổng tra cứu ngoài LIMS).
 *
 * Đổi domain/định dạng ở đây - mọi màn hình phát hành phiếu đều dùng chung hàm này
 * nên không còn chuỗi URL lặp lại trong từng component.
 */
const PORTAL_LOOKUP_BASE_URL =
  (import.meta.env["VITE_PORTAL_LOOKUP_URL"] as string | undefined) ||
  "https://dalienphat.com.vn/tra-cuu";

/** Host hiển thị cho người dùng ("Link tra cứu trên …"). */
export function portalLookupHost(): string {
  try {
    return new URL(PORTAL_LOOKUP_BASE_URL).host;
  } catch {
    return PORTAL_LOOKUP_BASE_URL;
  }
}

/** URL tra cứu đầy đủ cho một mã phiếu kết quả. */
export function portalLookupUrl(lookupCode: string): string {
  return `${PORTAL_LOOKUP_BASE_URL}?code=${encodeURIComponent(lookupCode)}`;
}
