// Phần thuần của live view (không đụng DOM, test độc lập): phím tắt, cử chỉ chạm/vuốt trên canvas, cửa sổ hàng của danh sách ảo.

export type Shortcut = 'stop' | 'enlarge' | 'takeover';

interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
}

interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
}

/** Thuộc tính của màn hình máy web đang giữ và nhận phím: phím ở đó đi vào trang (keys.ts), không phải phím tắt. */
export const WEB_KEYS_ATTR = 'data-web-keys';

const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const PRESSABLE = new Set(['BUTTON', 'A', 'SUMMARY']);

/**
 * Phím tắt của màn làm việc: Esc dừng tất cả ở mọi nơi (kể cả đang gõ, không hỏi), trừ khi đang mở hộp thoại: khi đó
 * Esc chỉ đóng hộp thoại. Enter phóng to máy đang chọn và T giành/trả quyền điều khiển, trừ khi đang gõ chữ (Enter trên
 * nút vẫn bấm nút). ⌘K thuộc thanh lệnh chat. Màn hình máy web đang giữ và có focus nhận mọi phím (kể cả Esc, T, Enter) cho trang.
 */
export function shortcutFor(e: KeyLike, target: TargetLike | null, dialogOpen = false): Shortcut | null {
  if (dialogOpen) return null;
  if (target?.closest?.(`[${WEB_KEYS_ATTR}]`)) return null;
  if (e.key === 'Escape') return e.repeat ? null : 'stop';
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return null;
  const tag = target?.tagName?.toUpperCase() ?? '';
  const typing = TYPING.has(tag) || !!target?.isContentEditable || target?.getAttribute?.('role') === 'textbox';
  if (typing) return null;
  // Phần tử tự xử lý Enter (nút thật hoặc role="button" như ô màn hình trực tiếp) không bị phím tắt phóng to giành mất.
  const pressable = PRESSABLE.has(tag) || target?.getAttribute?.('role') === 'button';
  if (e.key === 'Enter') return pressable ? null : 'enlarge';
  if (e.key === 't' || e.key === 'T') return 'takeover';
  return null;
}

export interface Point {
  x: number; // theo tỉ lệ khung ảnh, 0..1
  y: number;
  t: number; // ms
}

export type Gesture = { kind: 'tap'; x: number; y: number } | { kind: 'swipe'; x1: number; y1: number; x2: number; y2: number; durationMs: number };

/** Dưới ngưỡng này (theo tỉ lệ màn hình) là chạm, trên là vuốt. */
export const TAP_SLOP = 0.02;

const clamp01 = (v: number) => Math.min(1, Math.max(0, Math.round(v * 1000) / 1000));

/** Toạ độ con trỏ trong khung ảnh của canvas, theo tỉ lệ 0..1. */
export function toUnit(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, t: number): Point {
  return { x: clamp01((clientX - rect.left) / rect.width), y: clamp01((clientY - rect.top) / rect.height), t };
}

/** Đổi điểm trên ảnh đã xoay `rot` độ (theo chiều kim đồng hồ) về điểm trên khung ảnh gốc của máy, cùng tỉ lệ 0..1. */
export function unrotate(p: Point, rot: 0 | 90 | 180 | 270): Point {
  switch (rot) {
    case 90:
      return { ...p, x: p.y, y: clamp01(1 - p.x) };
    case 180:
      return { ...p, x: clamp01(1 - p.x), y: clamp01(1 - p.y) };
    case 270:
      return { ...p, x: clamp01(1 - p.y), y: p.x };
    default:
      return p;
  }
}

/** Nhấn rồi thả trên canvas thành một lệnh chạm hoặc vuốt (thời gian vuốt theo tay người, trong 100..2000 ms). */
export function gestureOf(down: Point, up: Point): Gesture {
  if (Math.hypot(up.x - down.x, up.y - down.y) < TAP_SLOP) return { kind: 'tap', x: down.x, y: down.y };
  return { kind: 'swipe', x1: down.x, y1: down.y, x2: up.x, y2: up.y, durationMs: Math.round(Math.min(2000, Math.max(100, up.t - down.t))) };
}

/**
 * Lăn chuột trên màn hình máy web thành một lệnh vuốt (cuộn trang): độ lăn theo tỉ lệ khung ảnh, đối xứng quanh tâm, tối đa
 * một màn hình mỗi lệnh. Lăn xuống (dy > 0) = vuốt lên, như cuộn bằng tay trên điện thoại.
 */
export function wheelGesture(dx: number, dy: number, rect: { width: number; height: number }): Gesture {
  const unit = (d: number, size: number) => Math.min(1, Math.max(-1, size > 0 ? d / size : 0));
  const ux = unit(dx, rect.width);
  const uy = unit(dy, rect.height);
  return { kind: 'swipe', x1: clamp01(0.5 + ux / 2), y1: clamp01(0.5 + uy / 2), x2: clamp01(0.5 - ux / 2), y2: clamp01(0.5 - uy / 2), durationMs: 100 };
}

/** Hàng cần vẽ của danh sách ảo: [đầu, cuối) theo vị trí cuộn, có thêm vài hàng đệm hai đầu. */
export function windowRange(scrollTop: number, viewport: number, rowHeight: number, count: number, overscan = 4): [number, number] {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(count, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
  return [first, Math.max(first, last)];
}
