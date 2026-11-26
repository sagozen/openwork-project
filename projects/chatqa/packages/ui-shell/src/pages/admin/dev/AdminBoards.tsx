// Bảng so ảnh cho harness (chỉ bản dev, được nạp qua Gallery /#/__ui/admin/...): vẽ khu quản trị trong cửa sổ Windows 1440×920
// để so với khung pen khi route thật `/cai-dat/*` chưa gắn vào Layout. Không bao giờ vào bản phát hành (Gallery chỉ import trong nhánh DEV).
import { MemoryRouter, Route, Routes } from 'react-router';
import { WindowsShell } from '../../../components/shell';
import { SHELL_SECTIONS } from '../../../components/ui/gallery/ShellBoard';
import AdminRoutes from '../AdminRoutes';
import { UserDialogView } from '../UserDialog';
import type { AdminUser } from '../admin-api';
import type { UserForm } from '../user-form';

function AdminWindow({ path }: { path: string }) {
  return (
    <div className="h-[920px] w-[1440px]">
      <WindowsShell
        appName="HS Báo giá"
        workspace="App 01 · Công ty Anh Tùng"
        search
        syncText="Đã đồng bộ Google Drive"
        account={{ initials: 'AT', role: 'admin', name: 'Hoàng Anh Tùng' }}
        sections={SHELL_SECTIONS}
        cloud={{ title: 'Google Drive', sub: 'Đồng bộ 2 phút trước', used: 'Đã dùng 3,2 GB', retention: 'Theo gói Google Drive' }}
      >
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/cai-dat/*" element={<AdminRoutes />} />
          </Routes>
        </MemoryRouter>
      </WindowsShell>
    </div>
  );
}

const LICENSE_APPS = ['quote', 'lot', 'check', 'teach'] as const;
const FORM: UserForm = { username: 'nguyenvy', displayName: 'Nguyễn Thảo Vy', role: 'staff', apps: [...LICENSE_APPS], isDeployer: false, password: 'Vy-7429-tam' };
const ANH_TUNG = { id: 'u-anh-tung', username: 'anhtung', display_name: 'Hoàng Anh Tùng', role: 'admin', status: 'active', apps: null, is_deployer: false, last_device: 'PC-VP-01' } as AdminUser;

const noop = () => undefined;

/** Z073K: hai lỗi chặn lưu cạnh nhau trên bảng nền be (E-009 tên trùng, E-010 admin cuối). */
function BlockedBoard() {
  const states = [
    {
      label: 'Tên đăng nhập đã được dùng',
      el: <UserDialogView overlay={false} width={606} mode="add" form={{ ...FORM, username: 'tranlan' }} onChange={noop} licenseApps={[...LICENSE_APPS]} canSave={false} error={{ code: 'username_taken', params: { username: 'tranlan' } }} />,
    },
    {
      label: 'Phải còn ít nhất một admin công ty',
      el: (
        <UserDialogView
          overlay={false}
          width={606}
          mode="edit"
          form={{ username: 'anhtung', displayName: 'Hoàng Anh Tùng', role: 'manager', apps: [...LICENSE_APPS], isDeployer: false, password: '' }}
          orig={ANH_TUNG}
          onChange={noop}
          licenseApps={[...LICENSE_APPS]}
          canSave={false}
          showStatus={false}
          error={{ code: 'last_admin' }}
          footerNote="Nguyễn Quốc Bảo là Admin Bên triển khai nên không được tính."
        />
      ),
    },
  ];
  return (
    <div className="stroke-in flex w-[1440px] flex-col gap-[28px] rounded-[16px] bg-board p-[56px] font-sans leading-[normal] text-text">
      <div className="flex w-full flex-col gap-[8px]">
        <span className="text-[12px] font-bold tracking-[2px] whitespace-nowrap text-accent">B4 · THÊM / SỬA NGƯỜI DÙNG</span>
        <h1 className="text-[36px] font-bold tracking-[-0.8px] whitespace-nowrap">Hai lỗi chặn lưu</h1>
        <p className="w-full text-[15px] text-text-2">Khác với cảnh báo lô và mặt hàng (không chặn), hai lỗi này giữ nút lưu cho tới khi sửa xong.</p>
      </div>
      <div className="flex w-full gap-[20px]">
        {states.map((s) => (
          <div key={s.label} className="flex min-w-0 flex-1 flex-col gap-[16px] rounded-[16px] bg-stage p-[24px]">
            <div className="flex w-full items-center gap-[8px]">
              <span className="h-[8px] w-[8px] rounded-full bg-red" />
              <span className="text-[13px] font-bold whitespace-nowrap">{s.label}</span>
            </div>
            {s.el}
          </div>
        ))}
      </div>
    </div>
  );
}

export const ADMIN_BOARDS: Record<string, { title: string; el: () => React.ReactNode }> = {
  'admin/nguoi-dung': { title: 'Quản trị · Người dùng (D7XS6 và hộp thoại)', el: () => <AdminWindow path="/cai-dat/nguoi-dung" /> },
  'admin/nguoi-dung/u-tran-lan': { title: 'Quản trị · Chi tiết người dùng (TJ5Yj)', el: () => <AdminWindow path="/cai-dat/nguoi-dung/u-tran-lan" /> },
  'admin/bang-quyen': { title: 'Quản trị · Bảng quyền (hR039, Fb6jS)', el: () => <AdminWindow path="/cai-dat/bang-quyen" /> },
  'admin/may': { title: 'Quản trị · Máy & bản quyền (NX9V3, HuMtq)', el: () => <AdminWindow path="/cai-dat/may" /> },
  'admin/nhat-ky': { title: 'Quản trị · Nhật ký (qZFX3)', el: () => <AdminWindow path="/cai-dat/nhat-ky" /> },
  'admin/cho-cong-nhan': { title: 'Quản trị · Chờ công nhận (MNKuG)', el: () => <AdminWindow path="/cai-dat/cho-cong-nhan" /> },
  'admin/dich-vu-ai': { title: 'Quản trị · Dịch vụ AI', el: () => <AdminWindow path="/cai-dat/dich-vu-ai" /> },
  'admin/luu-bi-chan': { title: 'Quản trị · Hai lỗi chặn lưu (Z073K)', el: () => <BlockedBoard /> },
};
