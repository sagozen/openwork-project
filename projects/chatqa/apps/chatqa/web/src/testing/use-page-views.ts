// Ghi "page_view" vào lịch sử sử dụng (usage_events, chỉ lưu trên máy) mỗi khi đổi trang. Ghi hỏng thì bỏ qua (testApi.track).
import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { testApi } from './bridge';

/** Trang = đường dẫn route (không query/hash) để gom theo màn, vd "/kiem-thu", "/cai-dat/kiem-thu". */
export const pageOf = (pathname: string) => pathname.replace(/\/+$/, '') || '/';

export function usePageViews() {
  const { pathname } = useLocation();
  useEffect(() => {
    void testApi.track('page_view', { page: pageOf(pathname) });
  }, [pathname]);
}
