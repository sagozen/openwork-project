// Định tuyến bản web/PWA (BR-016, NFR-009): chỉ Báo cáo (vai có report.view) và Quản trị (Admin). Mọi đường dẫn khác, kể cả gõ thẳng URL,
// hiện màn "Chưa có quyền" (E-013); Worker vẫn chặn API lần nữa.
import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { useSession } from '../../lib/session';
import { webHome } from '../../lib/auth-flow';
import { WebScreen } from '../../components/shell';
import { homePath, NO_ACCESS_PATH, PASSWORD_PATH } from '../../components/shell/web-chrome';
import { PolicyPage } from '../public/PolicyPage';
import { TermsPage } from '../public/TermsPage';
import { LOGIN_PATH, POLICY_PATH, TERM_PATH } from '../public/paths';

const AdminArea = lazy(() => import('./AdminArea'));
const NoPermissionPage = lazy(() => import('./NoPermissionPage'));
const ReportPage = lazy(() => import('./ReportPage'));

const Loading = () => <p className="py-16 text-center text-sm text-text-3">Đang tải...</p>;

export default function WebRoutes() {
  const { state } = useSession();
  const home = webHome(state?.user?.role, state?.user?.perms);
  const to = homePath(home);
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route index element={<Navigate to={to} replace />} />
        <Route path={LOGIN_PATH} element={<Navigate to={to} replace />} />
        {/* Trang pháp lý công khai: người đã đăng nhập vẫn mở được (link ở chân trang) */}
        <Route path={POLICY_PATH} element={<PolicyPage />} />
        <Route path={TERM_PATH} element={<TermsPage />} />
        <Route path={NO_ACCESS_PATH} element={<NoPermissionPage />} />
        {/* Hộp Đổi mật khẩu mở từ menu tài khoản; đường dẫn này chỉ để mở thẳng hộp (WebScreen vẽ hộp) */}
        <Route path={PASSWORD_PATH} element={<WebScreen bare />} />
        {home !== 'none' && <Route path="/bao-cao" element={<ReportPage />} />}
        {home === 'admin' && <Route path="/quan-tri/*" element={<AdminArea />} />}
        <Route path="*" element={<NoPermissionPage />} />
      </Routes>
    </Suspense>
  );
}
