// Góc xoay màn hình của từng máy, nhớ qua các lần mở app: iPad đặt ngang trả ảnh chụp dọc nên người xem cần xoay lại cho thẳng.
import { useSyncExternalStore } from 'react';
import type { Rotation } from './frames';

const KEY = 'chatqa.screenRotation';
const subs = new Set<() => void>();
let cache: Record<string, Rotation> | undefined;

function load(): Record<string, Rotation> {
  if (cache) return cache;
  try {
    cache = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}') as Record<string, Rotation>;
  } catch {
    cache = {};
  }
  return cache;
}

export const rotationOf = (id: string): Rotation => load()[id] ?? 0;

/** Xoay thêm 90 độ theo chiều kim đồng hồ. */
export function rotateNext(id: string): void {
  const next = ((rotationOf(id) + 90) % 360) as Rotation;
  cache = { ...load(), [id]: next };
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(cache));
  } catch {
    // không lưu được: vẫn xoay trong phiên này
  }
  subs.forEach((f) => f());
}

const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => subs.delete(fn);
};

export function useRotation(id: string): Rotation {
  const snap = () => rotationOf(id);
  return useSyncExternalStore(subscribe, snap, snap);
}
