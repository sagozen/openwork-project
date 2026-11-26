import { useEffect, useReducer, useRef } from 'react';
import { platform } from '../platform';
import { countText, createDurationStore, createNetStore, estimate, median, timeText, type NetStore } from './net-progress';

let store: NetStore | null = null;

/** Kho dùng chung cả app; gắn vào sự kiện `net:progress` của Go đúng một lần (PWA không có sự kiện nên kho luôn trống). */
export function netStore(): NetStore {
  if (!store) {
    store = createNetStore(createDurationStore());
    platform.onNetProgress?.((e) => store?.ingest(e));
  }
  return store;
}

export interface NetView {
  /** Việc đang làm: nhãn Go gửi, hoặc nhãn dự phòng khi chưa có sự kiện. */
  label: string;
  /** "120/300 dòng"; "" khi không đếm được. */
  count: string;
  /** "đã chờ 4 giây · còn khoảng 6 giây"; "" khi mới bắt đầu. */
  time: string;
  /** 0..1 để vẽ thanh; null = không có cơ sở (vòng quay/thanh chạy). */
  fraction: number | null;
  /** Ghi chú phụ ("Mạng chậm, đang thử lại"). */
  note: string;
  slow: boolean;
}

/**
 * Chi tiết một thao tác mạng đang chạy. `op`: khoá ổn định trùng khoá Go truyền cho netprog.Begin ("vipo.read-sheet");
 * `active`: thao tác đang chạy theo giao diện (thường là busy của useAction); `fallbackLabel`: nhãn khi Go chưa báo
 * (PWA, hoặc thao tác chưa gắn netprog). Trả null khi không active.
 * Lần chạy thành công được ghi vào lịch sử thời lượng để lần sau ước "còn bao lâu".
 */
export function useNetProgress(op: string, active: boolean, fallbackLabel: string): NetView | null {
  const s = netStore();
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const startRef = useRef(0);
  const wasActive = useRef(false);

  // Mốc bắt đầu đặt ngay trong lúc render lần đầu thấy active, để giây đầu tiên không tính lệch.
  if (active && !wasActive.current) startRef.current = s.clock();

  useEffect(() => {
    if (!active) return;
    const off = s.subscribe(tick);
    const timer = setInterval(tick, 500); // thời gian đã chờ nhích đều dù Go chưa gửi gì mới
    return () => {
      off();
      clearInterval(timer);
    };
  }, [active, s]);

  useEffect(() => {
    if (active) {
      wasActive.current = true;
      return;
    }
    if (!wasActive.current) return;
    wasActive.current = false;
    // Không có sự kiện Go cho lần này (PWA hoặc chưa gắn netprog): tự ghi thời lượng để lần sau vẫn ước được.
    const run = s.get(op);
    if (!run || run.seenAt < startRef.current) s.durations.add(op, s.clock() - startRef.current);
    s.clear(op);
  }, [active, op, s]);

  if (!active) return null;
  const run = s.get(op);
  const mine = run && run.state === 'running' && run.seenAt >= startRef.current ? run : undefined;
  const elapsedMs = Math.max(0, s.clock() - (mine?.seenAt ?? startRef.current));
  const est = estimate({ elapsedMs, done: mine?.done ?? 0, total: mine?.total ?? 0, typicalMs: median(s.durations.list(op)) });
  return {
    label: mine?.label || fallbackLabel,
    count: mine ? countText(mine) : '',
    time: timeText(est),
    fraction: est.fraction,
    note: mine?.note ?? '',
    slow: est.slow,
  };
}
