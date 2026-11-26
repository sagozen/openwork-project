// Máy trạng thái vào app: kích hoạt -> đăng nhập -> (đổi mật khẩu bắt buộc) -> màn chính, cùng các hộp thoại toàn cục chồng lên.
import { NO_AUTH, type AppItem, type AppState, type AuthState } from '../platform/types';
import { isAdmin } from '../platform/roles';

export type Entry = 'loading' | 'activate' | 'login' | 'mustChange' | 'locked' | 'ready';

const BAD_LICENSE = ['none', 'expired', 'invalid'];

/**
 * Màn người dùng đang ở.
 * - Máy Windows bị thu hồi (E-016): màn khoá, không cho kích hoạt lại bằng tay ở đây (admin kích hoạt lại).
 * - Hết hạn offline (E-006) KHÔNG đưa về màn kích hoạt: dữ liệu còn nguyên, chỉ khoá màn làm việc (overlay).
 */
export function entryScreen(state: AppState | null, desktop: boolean): Entry {
  if (!state) return 'loading';
  const auth = state.auth ?? NO_AUTH;
  if (desktop) {
    if (auth.overlay === 'revoked') return 'locked';
    if (!state.license || BAD_LICENSE.includes(state.license.status)) return 'activate';
  }
  if (!state.user) return 'login';
  if (auth.mustChangePassword) return 'mustChange';
  return 'ready';
}

export type Overlay = Exclude<AuthState['overlay'], ''> | null;

/** Hộp thoại/khoá toàn cục cần hiện (E-005, E-006, E-016, E-019). */
export function overlayOf(state: AppState | null): Overlay {
  return (state?.auth?.overlay || null) as Overlay;
}

/** Trạng thái một app trên menu; PWA không có bản quyền theo máy nên suy từ người dùng. */
export function appItem(state: AppState | null, code: string): AppItem | undefined {
  return state?.apps?.find((a) => a.code === code);
}

/** Vai nào thấy màn nào trên web (BR-016): Báo cáo cho vai có report.view, quản trị cho admin; còn lại E-013. */
export type WebHome = 'admin' | 'report' | 'none';
export function webHome(role: string | undefined, perms: readonly string[] | undefined): WebHome {
  if (isAdmin(role)) return 'admin';
  return perms?.includes('report.view') ? 'report' : 'none';
}
