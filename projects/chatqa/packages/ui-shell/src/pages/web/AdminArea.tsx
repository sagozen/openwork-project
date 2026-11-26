import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Clock, HardDrive, Monitor, ScrollText, Table2, Users } from 'lucide-react';
import { WebScreen } from '../../components/shell';
import { useIsPhone } from '../../lib/use-phone';
import AdminRoutes from '../admin/AdminRoutes';
import { adminTabOn } from '../admin/admin-tabs';
import { TAB_PATHS, useAdmin, type TabKey } from '../admin/admin-context';
import { IS_HSDESK } from '../../lib/catalog';

const ALL_ITEMS: { key: TabKey; label: string; icon: ReactNode }[] = [
  { key: 'users', label: 'Người dùng & quyền', icon: <Users size={16} /> },
  { key: 'matrix', label: 'Bảng quyền theo vai', icon: <Table2 size={16} /> },
  { key: 'devices', label: 'Máy & bản quyền', icon: <Monitor size={16} /> },
  { key: 'audit', label: 'Nhật ký quản trị', icon: <ScrollText size={16} /> },
  { key: 'pending', label: 'Chờ công nhận', icon: <Clock size={16} /> },
  { key: 'drive', label: 'Kết nối Drive', icon: <HardDrive size={16} /> },
];
const ITEMS = ALL_ITEMS.filter((i) => adminTabOn(i.key));

/** Khu Quản trị trên web desktop: sidebar sáng QUẢN TRỊ · CHỈ ADMIN (thay hàng tab của Windows) + thẻ "Trên web". Điện thoại: từng trang tự vẽ đầu trang. */
function AdminFrame({ children }: { children: ReactNode }) {
  const { base, pending } = useAdmin();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const phone = useIsPhone();
  if (phone) return <>{children}</>;
  const sections = [
    {
      label: 'QUẢN TRỊ · CHỈ ADMIN',
      items: ITEMS.map((i) => {
        const to = `${base}/${TAB_PATHS[i.key]}`;
        return { key: i.key, label: i.label, icon: i.icon, href: to, active: pathname === to || pathname.startsWith(`${to}/`), badge: i.key === 'pending' && pending ? pending : undefined, onClick: () => navigate(to) };
      }),
    },
  ];
  return (
    <WebScreen sections={sections} scopeNote={IS_HSDESK ? { title: 'Trên web', text: 'Duyệt và Yêu cầu sửa chỉ làm trên app Windows ở v1. Web không có Danh sách chờ duyệt.' } : undefined}>
      {children}
    </WebScreen>
  );
}

export default function AdminArea() {
  return <AdminRoutes chrome="web" Frame={AdminFrame} />;
}
