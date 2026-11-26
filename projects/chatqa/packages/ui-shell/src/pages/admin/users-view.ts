// Danh sách người dùng: lọc, trạng thái hiển thị, tên hàng (D7XS6). Hàm thuần để test.
import { roleServedByProduct } from '../../platform/roles';
import type { AdminUser, UserStatus } from './admin-api';

export type RoleFilter = 'all' | 'admin' | 'manager' | 'leader' | 'staff' | 'vipo';
export type StatusFilter = 'all' | UserStatus;

export const STATUS_OPTIONS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'Tất cả' },
  { key: 'active', label: 'Hoạt động' },
  { key: 'temp_locked', label: 'Khoá tạm' },
  { key: 'locked', label: 'Đã khoá' },
];

export const STATUS_VIEW: Record<UserStatus, { tone: 'green' | 'amber' | 'red'; label: string }> = {
  active: { tone: 'green', label: 'Hoạt động' },
  temp_locked: { tone: 'amber', label: 'Khoá tạm' },
  locked: { tone: 'red', label: 'Đã khoá' },
};

export function filterUsers(users: AdminUser[], role: RoleFilter, status: StatusFilter): AdminUser[] {
  return users.filter((u) => (role === 'all' || u.role === role) && (status === 'all' || u.status === status));
}

/**
 * Tài khoản thuộc sản phẩm đang chạy: bỏ vai chỉ dùng ở sản phẩm khác (Vipo chỉ đăng nhập được HS Desk,
 * Worker từ chối phiên ChatQASoftware) để danh sách không bày tài khoản không dùng được app này.
 */
export const visibleUsers = (users: AdminUser[], product?: string): AdminUser[] => users.filter((u) => roleServedByProduct(u.role, product));

/** Tag dưới tên: Bên triển khai và Đã khoá (BR-011). */
export const userTag = (u: Pick<AdminUser, 'is_deployer' | 'status'>): 'deployer' | 'locked' | undefined => (u.is_deployer ? 'deployer' : u.status === 'locked' ? 'locked' : undefined);

/** Tài khoản đã khoá: mở lại được, không có Xoá (BR-006). */
export const canUnlock = (u: Pick<AdminUser, 'status'>) => u.status === 'locked';
