// Khu quản trị (Cài đặt › người dùng, bảng quyền, máy, nhật ký, chờ công nhận, dịch vụ AI, kết nối Drive).
// Gắn vào router của app (Windows: route `/cai-dat/*`; web: `/quan-tri/*`, tải lười); các trang không biết shell nào bao quanh.
// Tab riêng của HS Desk (Chờ công nhận) ẩn ở sản phẩm khác (./admin-tabs.ts).
import { Fragment, type ComponentType, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router';
import { AdminProvider, usePhoneLayout, type AdminChrome, type AdminExtraTab } from './admin-context';
import { adminTabOn } from './admin-tabs';
import AdminMenuPhone from './phone/AdminMenuPhone';
import DrivePage from './DrivePage';
import { AdminPage } from './parts';
import { AiConsentCard, AiServicePanel } from './AiPanels';
import AuditPage from './AuditPage';
import DevicesPage from './DevicesPage';
import PendingOpsPage from './PendingOpsPage';
import RoleMatrixPage from './RoleMatrixPage';
import UserDetailPage from './UserDetailPage';
import UsersPage from './UsersPage';
import { IS_HSDESK } from '../../lib/catalog';

function AiPage() {
  // Thẻ đồng ý xử lý dữ liệu AI (ảnh hàng hóa, Sổ dạy AI, lịch sử trên Drive) là của HS Desk.
  const desk = IS_HSDESK;
  return (
    <AdminPage tab="ai" crumb="Cài đặt › Dịch vụ AI · chỉ Admin" title="Dịch vụ AI">
      <div className="flex min-h-0 flex-1 gap-[16px]">
        {desk && (
          <div className="flex min-w-0 flex-1 flex-col gap-[16px]">
            <AiConsentCard />
          </div>
        )}
        <AiServicePanel />
      </div>
    </AdminPage>
  );
}

/** Trang gốc: điện thoại hiện menu Quản trị (WsSHs); còn lại về tab đầu tiên. */
function AdminIndex({ base }: { base: string }) {
  return usePhoneLayout() ? <AdminMenuPhone /> : <Navigate to={`${base}/nguoi-dung`} replace />;
}

/** `chrome`: vỏ bao quanh (mặc định cửa sổ Windows); `Frame`: khung bọc các trang (web: thanh bên). */
export default function AdminRoutes({ chrome = 'windows', Frame = Fragment, extraTabs }: { chrome?: AdminChrome; Frame?: ComponentType<{ children: ReactNode }>; extraTabs?: AdminExtraTab[] }) {
  // Gốc của khu này trong router cha (vd "/cai-dat"): đường dẫn hiện tại bỏ phần "*" của route cha. Các tab và liên kết nội bộ tính từ đây.
  const { pathname } = useLocation();
  const splat = useParams()['*'] ?? '';
  const base = (pathname.endsWith(splat) ? pathname.slice(0, pathname.length - splat.length) : pathname).replace(/\/$/, '') || '/cai-dat';
  return (
    <AdminProvider base={base} chrome={chrome} extraTabs={extraTabs}>
      <Frame>
        <Routes>
          <Route index element={<AdminIndex base={base} />} />
          <Route path="nguoi-dung" element={<UsersPage />} />
          <Route path="nguoi-dung/:id" element={<UserDetailPage />} />
          <Route path="bang-quyen" element={<RoleMatrixPage />} />
          <Route path="may" element={<DevicesPage />} />
          <Route path="nhat-ky" element={<AuditPage />} />
          {adminTabOn('pending') && <Route path="cho-cong-nhan" element={<PendingOpsPage />} />}
          {chrome === 'windows' && <Route path="dich-vu-ai" element={<AiPage />} />}
          {adminTabOn('drive') && <Route path="drive" element={<DrivePage />} />}
          {extraTabs?.map((t) => <Route key={t.key} path={t.path} element={t.element} />)}
          <Route path="*" element={<Navigate to={`${base}/nguoi-dung`} replace />} />
        </Routes>
      </Frame>
    </AdminProvider>
  );
}
