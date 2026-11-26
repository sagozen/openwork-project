import { createContext, useContext } from 'react';
import type { AppCode, AppItem, AppState, AuthState } from '../platform';

// Context để riêng khỏi session.tsx: sửa SessionProvider (hoặc git đổi file khi đang chạy dev) chỉ nạp lại session.tsx,
// object context giữ nguyên nên provider đang gắn và các useSession vẫn khớp nhau. Nếu tạo context trong session.tsx,
// mỗi lần HMR sinh context mới và app báo "useSession ngoài SessionProvider" tới khi tải lại cửa sổ.

export interface SessionCtx {
  state: AppState | null;
  loading: boolean;
  /** Lỗi lần tải trạng thái gần nhất (Go chưa sẵn sàng, mất mạng ở PWA...). */
  error: unknown;
  refresh: () => Promise<void>;
  /** Được dùng app: bản quyền máy bật app VÀ người dùng được cấp app. */
  hasApp: (code: AppCode) => boolean;
  /** Lý do bị khoá (để báo đúng: liên hệ ai). */
  appAccess: (code: AppCode) => AppAccess;
  /** Có quyền thao tác (vd 'approve.review'): theo vai ở bảng quyền, admin luôn có. */
  can: (perm: string) => boolean;
  /** Trạng thái toàn cục (hộp thoại, số mục chờ đồng bộ...). */
  auth: AuthState;
  /** Một app trên menu (desktop): trạng thái + lỗi hiện khi bấm. */
  appItem: (code: AppCode) => AppItem | undefined;
  /** Tên công ty từ bản quyền; chưa có thì tên sản phẩm. */
  company: string;
  /** Tên đăng nhập vừa dùng (nhớ để điền lại ở hộp "phiên hết hạn" và tiêu đề hộp đổi mật khẩu). */
  username: string;
  /** Ghi nhớ tên đăng nhập; mật khẩu chỉ giữ trong bộ nhớ cho tới khi đổi xong mật khẩu tạm (không bao giờ lưu đĩa). */
  rememberLogin: (username: string, password: string) => void;
  /** Mật khẩu tạm vừa đăng nhập (chỉ trong bộ nhớ) để gửi làm "mật khẩu hiện tại" khi đổi bắt buộc. */
  tempPassword: () => string;
}

export type AppAccess = 'ok' | 'license' | 'user';

export const SessionContext = createContext<SessionCtx | null>(null);

export function useSession() {
  const c = useContext(SessionContext);
  if (!c) throw new Error('useSession ngoài SessionProvider');
  return c;
}
