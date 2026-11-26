/**
 * Nhận diện và Việt hoá lỗi Clerk ở chế độ Restricted (chỉ email được mời mới vào được).
 */

interface ClerkApiError {
  code?: string;
  longMessage?: string;
  message?: string;
}

/** Lấy danh sách lỗi từ ClerkAPIResponseError, bất kể error được bọc kiểu gì. */
function clerkErrors(err: unknown): ClerkApiError[] {
  const errors = (err as { errors?: ClerkApiError[] } | null)?.errors;
  return Array.isArray(errors) ? errors : [];
}

/** Các mã Clerk trả về khi instance đang bật Restricted / Waitlist. */
const RESTRICTED_CODES = new Set([
  "not_allowed_access",
  "sign_up_mode_restricted",
  "sign_up_mode_restricted_waitlist",
]);

export function isRestrictedCode(code: string | undefined | null): boolean {
  return !!code && (RESTRICTED_CODES.has(code) || code.includes("restricted"));
}

export function isRestrictedSignUpError(err: unknown): boolean {
  return clerkErrors(err).some((e) => isRestrictedCode(e.code));
}

export const RESTRICTED_MESSAGE_VI =
  "Hệ thống chỉ dành cho tài khoản nội bộ được mời trước. Email này chưa nằm trong danh sách cho phép, vui lòng liên hệ quản trị viên để được cấp quyền.";

export function describeClerkError(err: unknown): string {
  if (isRestrictedSignUpError(err)) return RESTRICTED_MESSAGE_VI;
  const first = clerkErrors(err)[0];
  return (
    first?.longMessage ||
    first?.message ||
    (err instanceof Error ? err.message : "Không hoàn tất được đăng nhập. Vui lòng thử lại.")
  );
}
