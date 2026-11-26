import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Bọc một thao tác bất đồng bộ (lưu, xoá, xuất, gọi API) để không chạy chồng.
 * - Đang chạy thì mọi lần gọi tiếp bị bỏ qua (trả `undefined`). Cờ giữ trong ref nên chặn được cả hai cú bấm
 *   rơi vào cùng một khung hình, lúc `busy` (state) chưa kịp render.
 * - `busy` dùng cho `<Button loading={busy}>` hoặc `disabled`.
 * - Không đặt state sau khi component đã gỡ.
 * Lỗi vẫn ném ra cho nơi gọi xử lý (try/catch của chính hàm bọc); cờ luôn được nhả trong `finally`.
 */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>): [run: (...args: A) => Promise<R | undefined>, busy: boolean] {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const alive = useRef(true);
  const latest = useRef(fn);
  latest.current = fn;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    setBusy(true);
    try {
      return await latest.current(...args);
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }, []);

  return [run, busy];
}
