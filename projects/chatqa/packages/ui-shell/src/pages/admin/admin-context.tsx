import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { adminApi } from './admin-api';
import { adminTabOn } from './admin-tabs';
import { useIsPhone } from '../../lib/use-phone';

/** Vỏ bao quanh khu quản trị: cửa sổ Windows (có hàng tab) hoặc web (thanh bên / menu điện thoại thay cho tab). */
export type AdminChrome = 'windows' | 'web';

/** Tab riêng của một sản phẩm, nối sau các tab chung (sản phẩm không có thì không truyền). */
export interface AdminExtraTab {
  key: string;
  label: string;
  /** Đường dẫn con dưới gốc quản trị, vd "kiem-thu". */
  path: string;
  element: ReactNode;
}
const NO_EXTRA_TABS: AdminExtraTab[] = [];

interface AdminCtx {
  /** Đường dẫn gốc của khu quản trị, vd "/cai-dat". Trang ghép vào shell nào cũng chỉ cần biết gốc này. */
  base: string;
  /** Số thao tác đang chờ công nhận (chấm vàng trên tab). null = chưa biết. */
  pending: number | null;
  setPending: (n: number) => void;
  chrome: AdminChrome;
  extraTabs: AdminExtraTab[];
}

const Ctx = createContext<AdminCtx>({ base: '/cai-dat', pending: null, setPending: () => undefined, chrome: 'windows', extraTabs: NO_EXTRA_TABS });
export const useAdmin = () => useContext(Ctx);
/** Bố cục điện thoại (dưới 768px) của khu quản trị trên web: thẻ và danh sách thay cho bảng rộng. */
export const usePhoneLayout = () => useAdmin().chrome === 'web' && useIsPhone();

export const TAB_PATHS = {
  users: 'nguoi-dung',
  matrix: 'bang-quyen',
  devices: 'may',
  audit: 'nhat-ky',
  pending: 'cho-cong-nhan',
  ai: 'dich-vu-ai',
  drive: 'drive',
} as const;
export type TabKey = keyof typeof TAB_PATHS;

export function AdminProvider({ base, chrome = 'windows', extraTabs = NO_EXTRA_TABS, children }: { base: string; chrome?: AdminChrome; extraTabs?: AdminExtraTab[]; children: ReactNode }) {
  const [pending, setPendingState] = useState<number | null>(null);
  const setPending = useCallback((n: number) => setPendingState(n), []);
  useEffect(() => {
    if (!adminTabOn('pending')) return;
    let live = true;
    // Mất mạng thì bỏ qua: màn đang mở tự báo E-020, chấm đếm chỉ là phụ.
    adminApi.pendingOps('pending').then((l) => live && setPendingState(l.length), () => undefined);
    return () => {
      live = false;
    };
  }, []);
  const value = useMemo(() => ({ base, pending, setPending, chrome, extraTabs }), [base, pending, setPending, chrome, extraTabs]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
