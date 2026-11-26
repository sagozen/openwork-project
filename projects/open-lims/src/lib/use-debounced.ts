import { useEffect, useState } from "react";

/**
 * Giữ lại giá trị sau khi người dùng ngừng gõ.
 *
 * Không có nó thì mỗi phím là một `queryKey` mới, và mỗi `queryKey` mới là một lần màn quay lại
 * `isPending` — màn nào dựng lại cây con theo `isPending` sẽ unmount chính ô đang gõ, ô mất focus
 * và các phím sau rơi ra ngoài. Đó là lý do ô tìm kiếm ở hàng chờ tiếp nhận chỉ nhận được hai ký
 * tự đầu của một mã lượt tám ký tự.
 */
export function useDebounced<T>(value: T, delayMs = 250) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
