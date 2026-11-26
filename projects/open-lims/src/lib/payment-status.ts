import type { StatusValue } from "@/lib/api";

/** Hai mã duy nhất được coi là đã xong khâu tiền: khách đã trả (`PAID`) hoặc được cấp ngoại lệ
 * (`EXCEPTION`). Mọi khoá nghiệp vụ theo thanh toán dùng chung điều kiện này để không lệch nhau
 * giữa các màn. `OVERDUE`/`PENDING_CONFIRMATION` đều là chưa xong. */
const SETTLED_PAYMENT_CODES = new Set(["PAID", "EXCEPTION"]);

export function isPaymentSettled(payment: StatusValue | undefined): boolean {
  return payment !== undefined && SETTLED_PAYMENT_CODES.has(payment.code);
}

/** Chặn thao tác khi - và chỉ khi - máy chủ có nói tình trạng thanh toán và tình trạng đó chưa
 * xong. Response thiếu hẳn trường thanh toán thì không suy diễn là chưa trả: khoá nhầm sẽ dừng cả
 * những hồ sơ đã trả tiền mà endpoint chưa trả kèm trường này. */
export function blocksOnPayment(payment: StatusValue | undefined): boolean {
  return payment !== undefined && !isPaymentSettled(payment);
}
