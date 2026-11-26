// Máy & bản quyền (FR-019, FR-020): thanh chỗ dùng, trạng thái máy, lời nhắc khi thu hồi.
import type { AdminDevice, LicenseView } from './admin-api';

export type SeatTone = 'in_use' | 'overdue' | 'free';

/** Mỗi chỗ một ô: máy đang dùng (xanh), máy quá hạn offline vẫn chiếm chỗ (cam), chỗ trống. Máy đã thu hồi không chiếm chỗ. */
export function seatSegments(maxDevices: number, devices: AdminDevice[]): SeatTone[] {
  const live = devices.filter((d) => d.status !== 'revoked');
  const overdue = live.filter((d) => d.status === 'offline_overdue').length;
  const inUse = live.length - overdue;
  const n = Math.max(maxDevices, live.length);
  return Array.from({ length: n }, (_, i) => (i < inUse ? 'in_use' : i < inUse + overdue ? 'overdue' : 'free'));
}

export const usedText = (lic: Pick<LicenseView, 'used' | 'maxDevices'>) => `Đã dùng ${lic.used}/${lic.maxDevices} máy`;
export const leftText = (lic: Pick<LicenseView, 'used' | 'maxDevices'>) => `còn ${Math.max(0, lic.maxDevices - lic.used)} máy`;

export const STATUS_CHIP: Record<AdminDevice['status'], { label: string; cls: string; dot: string }> = {
  in_use: { label: 'Đang dùng', cls: 'bg-green-soft text-green', dot: 'bg-green' },
  offline_overdue: { label: 'Quá hạn offline', cls: 'bg-amber-soft text-amber', dot: 'bg-amber' },
  revoked: { label: 'Đã thu hồi', cls: 'bg-chip-neutral text-text-3', dot: 'bg-text-3' },
};

/** "Sau khi thu hồi, công ty còn N máy trống": chỗ trống hiện tại + 1 (máy bị thu hồi trả lại một chỗ). */
export const freeAfterRevoke = (lic: Pick<LicenseView, 'used' | 'maxDevices'>) => Math.max(0, lic.maxDevices - lic.used) + 1;

export const offlineDays = (offlineHours: number) => Math.round(offlineHours / 24);
