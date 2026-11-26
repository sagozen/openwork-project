// FR-009: lô đang giữ và mặt hàng đang khoá của một người, trước khi hạ vai / bỏ app / khoá tài khoản.
// Dữ liệu này nằm trên máy Windows (Worker không giữ dữ liệu nghiệp vụ). Hàm Go tương ứng CHƯA có (Go đã đóng băng ở phase 04),
// nên ở đây trả "unavailable" thay vì bịa số liệu; khi có binding thì nối vào loadPreflight và panel tự hiện danh sách.
import { isDesktop } from '../../platform';
import type { AppCode } from '../../platform/types';
import { demoState } from './demo';

export interface Preflight {
  lots: { code: string; app: AppCode; rows: number }[];
  items: { name: string; app: AppCode }[];
  /** Thay đổi còn chờ đồng bộ trên máy gần nhất của người này (nếu máy báo). */
  pendingSync?: { count: number; device: string; lastSeen: string };
}

export type PreflightState = { status: 'ready'; data: Preflight } | { status: 'unavailable'; reason: 'web' | 'no-binding' };

/** Dữ liệu mẫu của khung pen HS Desk, chỉ dùng khi chạy bộ so ảnh ở bản dev (mã app của HS Desk, nên ép kiểu khi shell chạy cho sản phẩm khác). */
const DEMO = {
  lots: [
    { code: 'LO-2611-014', app: 'lot', rows: 38 },
    { code: 'LO-2611-019', app: 'check', rows: 12 },
  ],
  items: [
    { name: 'Ấm siêu tốc inox 1.8L', app: 'quote' },
    { name: 'Quạt tích điện mini', app: 'quote' },
    { name: 'Nồi chiên không dầu 5L', app: 'quote' },
  ],
  pendingSync: { count: 7, device: 'PC-BG-02', lastSeen: '09:15' },
} as unknown as Preflight;

export async function loadPreflight(_userId: string): Promise<PreflightState> {
  if (import.meta.env.DEV && ['dialog-edit-warning', 'dialog-lock'].includes(demoState() ?? '')) return { status: 'ready', data: DEMO };
  return { status: 'unavailable', reason: isDesktop ? 'no-binding' : 'web' };
}
