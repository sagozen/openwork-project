// Bộ định tuyến các trang công khai, dùng được khi chưa đăng nhập: trang chủ, chính sách, điều khoản và trang đăng nhập riêng.
// Người đã đăng nhập đi vào app qua WebRoutes (trang chủ "/" khi đó chuyển về màn theo vai).
import { Navigate, Route, Routes } from 'react-router';
import { LoginPage } from '../auth/LoginPage';
import { LandingPage } from './LandingPage';
import { PolicyPage } from './PolicyPage';
import { TermsPage } from './TermsPage';
import { LANDING_PATH, LOGIN_PATH, POLICY_PATH, TERM_PATH } from './paths';

export function PublicRoutes() {
  return (
    <Routes>
      <Route path={LANDING_PATH} element={<LandingPage />} />
      <Route path={POLICY_PATH} element={<PolicyPage />} />
      <Route path={TERM_PATH} element={<TermsPage />} />
      <Route path={LOGIN_PATH} element={<LoginPage />} />
      {/* Đường dẫn app khi chưa đăng nhập: về màn đăng nhập, không lộ màn hình bên trong. */}
      <Route path="*" element={<Navigate to={LOGIN_PATH} replace />} />
    </Routes>
  );
}
