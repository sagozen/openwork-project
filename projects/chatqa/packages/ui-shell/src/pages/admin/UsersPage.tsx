import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleDot, Ellipsis, KeyRound, Lock, LockOpen, Monitor, Pencil, Shield, Table2, UserPlus } from 'lucide-react';
import { useNavigate } from 'react-router';
import { AppChip, Button, DataTable, Menu, MenuItem, MenuNote, OnlyRequestTag, RoleChip, StatusDot, Tag, type Column } from '../../components/ui';
import { NetProgress } from '../../components/NetProgress';
import { PRODUCT_APPS, IS_HSDESK } from '../../lib/catalog';
import { useAction } from '../../lib/use-action';
import type { AppCode } from '../../platform/types';
import { adminApi, type AdminUser } from './admin-api';
import { useAdmin, usePhoneLayout } from './admin-context';
import { AiConsentCard, AiServicePanel } from './AiPanels';
import { demoState } from './demo';
import { appNo, fmtDayTime } from './format';
import { AdminPage, AdminToast, ErrorBanner, FilterMenu, UserAvatar } from './parts';
import { PhoneAdminPage } from './phone/parts';
import { UsersPhone } from './phone/UsersPhone';
import { unlockUser, UserActionDialogs, type UserDialogState } from './UserActionDialogs';
import { useResource } from './use-resource';
import { filterUsers, visibleUsers, STATUS_OPTIONS, STATUS_VIEW, userTag, type RoleFilter, type StatusFilter } from './users-view';
import { ROLE_OPTIONS } from './user-form';

const ROLE_FILTERS: { key: RoleFilter; label: string }[] = [{ key: 'all', label: 'Tất cả' }, ...(ROLE_OPTIONS as { key: RoleFilter; label: string }[])];
const GRID_APPS = PRODUCT_APPS.filter((a) => a.status === 'active').map((a) => a.code as AppCode);

type Toast = { text: string; icon: 'check' } | null;

export default function UsersPage() {
  const navigate = useNavigate();
  const { base, chrome } = useAdmin();
  const onWeb = chrome === 'web';
  const phone = usePhoneLayout();
  const res = useResource(async () => {
    const [users, license] = await Promise.all([adminApi.users(), adminApi.license().catch(() => null)]);
    return { users, licenseApps: (license?.apps ?? GRID_APPS) as AppCode[] };
  });
  const [role, setRole] = useState<RoleFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [dialog, setDialog] = useState<UserDialogState>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [flash, setFlash] = useState<string | null>(null);
  // Chỉ bộ so ảnh (?demo=row-active): tô hàng như khi rê chuột mà không mở menu.
  const [activeRow, setActiveRow] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const nowSec = Math.floor(Date.now() / 1000);

  // Bỏ tài khoản vai của sản phẩm khác (Vipo chỉ đăng nhập HS Desk): không sửa được ở đây vì biểu mẫu không có vai đó.
  const users = useMemo(() => visibleUsers(res.data?.users ?? []), [res.data]);
  const licenseApps = res.data?.licenseApps ?? GRID_APPS;
  const rows = useMemo(() => filterUsers(users, role, status), [users, role, status]);

  // Bộ so ảnh: mở sẵn menu / hộp thoại theo ?demo= (chỉ bản dev).
  useEffect(() => {
    if (import.meta.env.DEV) {
      // Cờ cách nhau dấu phẩy (vd ?demo=menu-open,window); lấy cờ đầu tiên không phải cờ khung.
      const d = demoState()?.split(',').find((f) => f !== 'window' && f !== 'phone') ?? null;
      if (!d || !users.length) return;
      const by = (u: string) => users.find((x) => x.username === u);
      if (d === 'menu-open') setMenuFor(by('tranlan')?.id ?? null);
      if (d === 'row-active') setActiveRow(by('tranlan')?.id ?? null);
      if (d === 'dialog-add') setDialog({ kind: 'add' });
      if (d.startsWith('dialog-edit') && by('tranlan')) setDialog({ kind: 'edit', user: by('tranlan')! });
      if (d.startsWith('dialog-lock') && by('tranlan')) setDialog({ kind: 'lock', user: by('tranlan')! });
      if (d === 'dialog-reset' && by('leha')) setDialog({ kind: 'reset', user: by('leha')! });
      if (d === 'reset-done' && by('leha')) {
        setFlash(by('leha')!.id);
        setToast({ text: 'Đã đặt lại mật khẩu cho Lê Hà. Lê Hà phải đổi mật khẩu ở lần đăng nhập tới. Mật khẩu tạm không hiện lại ở đâu nữa.', icon: 'check' });
      }
    }
  }, [users.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Đóng menu "..." khi bấm ra ngoài.
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuFor) return;
    const away = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenuFor(null);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [menuFor]);

  const done = useCallback(
    async (text: string, flashId?: string) => {
      setDialog(null);
      setToast({ text, icon: 'check' });
      setFlash(flashId ?? null);
      await res.reload();
    },
    [res],
  );

  // Menu giữ mở (mục Mở khoá khoá lại, hiện "Đang mở khoá…") tới khi máy chủ trả lời, rồi mới đóng.
  const [unlock, unlocking] = useAction(async (u: AdminUser) => {
    setActionError(null);
    try {
      await unlockUser(u);
      setMenuFor(null);
      await done(`Đã mở khoá tài khoản ${u.display_name}.`);
    } catch (e) {
      setMenuFor(null);
      setActionError(e);
    }
  });

  const rowMenu = (u: AdminUser) => (
    <Menu>
      <MenuItem active icon={<Pencil size={14} />} onClick={() => (setMenuFor(null), setDialog({ kind: 'edit', user: u }))}>
        Sửa
      </MenuItem>
      <MenuItem icon={<KeyRound size={14} />} onClick={() => (setMenuFor(null), setDialog({ kind: 'reset', user: u }))}>
        Đặt lại mật khẩu
      </MenuItem>
      {u.status === 'locked' ? (
        <MenuItem icon={<LockOpen size={14} />} disabled={unlocking} aria-busy={unlocking || undefined} onClick={() => void unlock(u)}>
          {unlocking ? 'Đang mở khoá…' : 'Mở khoá tài khoản'}
        </MenuItem>
      ) : (
        <MenuItem tone="danger" icon={<Lock size={14} />} onClick={() => (setMenuFor(null), setDialog({ kind: 'lock', user: u }))}>
          Khoá tài khoản
        </MenuItem>
      )}
      <MenuNote>Không có Xoá. Tài khoản đã khoá vẫn giữ lịch sử.</MenuNote>
    </Menu>
  );

  const columns: Column<AdminUser>[] = [
    {
      key: 'who',
      header: 'TÊN HIỂN THỊ',
      render: (u) => (
        <div className="flex min-w-0 items-center gap-[8px]">
          <UserAvatar user={u} />
          <div className="flex flex-col gap-[3px]">
            <button type="button" onClick={() => navigate(`${base}/nguoi-dung/${u.id}`)} className="text-left text-[12px]/[15px] font-semibold whitespace-nowrap text-text hover:underline">
              {u.display_name}
            </button>
            {userTag(u) && (
              <span className="flex">
                <Tag kind={userTag(u)!} />
              </span>
            )}
          </div>
        </div>
      ),
    },
    { key: 'username', header: 'TÊN ĐĂNG NHẬP', width: 84, render: (u) => <span className="block truncate font-mono text-[10.5px]/[14px] text-text-2">{u.username}</span> },
    { key: 'role', header: 'VAI', width: 72, render: (u) => <RoleChip role={u.role} /> },
    {
      key: 'apps',
      header: 'APP ĐƯỢC CẤP',
      width: 100,
      render: (u) =>
        u.role === 'vipo' ? (
          <OnlyRequestTag>Gửi yêu cầu</OnlyRequestTag>
        ) : (
          <div className="flex items-center gap-[3px]">
            {GRID_APPS.map((c) => (
              <AppChip key={c} no={appNo(c)} granted={(u.apps ?? licenseApps).includes(c)} />
            ))}
          </div>
        ),
    },
    { key: 'status', header: 'TRẠNG THÁI', width: 80, render: (u) => <StatusDot tone={STATUS_VIEW[u.status].tone}>{STATUS_VIEW[u.status].label}</StatusDot> },
    {
      key: 'machine',
      header: 'MÁY GẦN NHẤT',
      width: 84,
      render: (u) => (
        <span className="flex min-w-0 items-center gap-[4px] text-[10px]/[13px] text-text-2">
          <Monitor size={11} className="shrink-0 text-text-3" />
          <span className="min-w-0 truncate">{u.last_device ?? '—'}</span>
        </span>
      ),
    },
    { key: 'last', header: 'ĐĂNG NHẬP CUỐI', width: 90, render: (u) => <span className="block text-[10.5px]/[13px] text-text-2">{u.last_login_at ? fmtDayTime(u.last_login_at, nowSec) : 'Chưa đăng nhập'}</span> },
    {
      key: 'act',
      header: '',
      width: 20,
      render: (u) => (
        <div ref={menuFor === u.id ? menuRef : undefined} className="relative h-[16px] w-[20px]">
          <button type="button" aria-label={`Thao tác với ${u.display_name}`} aria-haspopup="menu" aria-expanded={menuFor === u.id} onClick={() => setMenuFor(menuFor === u.id ? null : u.id)} className="flex w-full justify-center">
            <Ellipsis size={16} className={menuFor === u.id || activeRow === u.id ? 'text-text' : 'text-text-3'} />
          </button>
          {menuFor === u.id && <div className="absolute top-[calc(100%+4px)] right-[4px] z-30">{rowMenu(u)}</div>}
        </div>
      ),
    },
  ];

  const dialogs = <UserActionDialogs dialog={dialog} setDialog={setDialog} users={users} licenseApps={licenseApps} onDone={(t, id) => void done(t, id)} onUnlock={(u) => void unlock(u)} unlocking={unlocking} />;
  const toastEl = toast && (
    <AdminToast icon={<Check size={15} />} onClose={() => setToast(null)}>
      {toast.text}
    </AdminToast>
  );

  if (phone) {
    return (
      <PhoneAdminPage title="Người dùng & quyền" error={res.error ?? actionError}>
        <NetProgress op="admin.users-load" active={res.loading && !res.data} label="Đang tải danh sách người dùng" className="self-center" />
        {!res.error && (
          <UsersPhone
            rows={rows}
            licenseApps={licenseApps}
            role={role}
            status={status}
            roleOptions={ROLE_FILTERS}
            onRole={setRole}
            onStatus={setStatus}
            onAdd={() => setDialog({ kind: 'add' })}
            onOpen={(u) => navigate(`${base}/nguoi-dung/${u.id}`)}
            menuFor={menuFor}
            onMenu={setMenuFor}
            renderMenu={(u) => <div ref={menuRef}>{rowMenu(u)}</div>}
            addDisabled={!res.data}
          />
        )}
        {dialogs}
        {toastEl}
      </PhoneAdminPage>
    );
  }

  return (
    <AdminPage
      tab="users"
      crumb="Cài đặt › Người dùng & quyền · chỉ Admin được sửa"
      title="Cài đặt: người dùng & quyền"
      web={{ crumb: 'Quản trị › Người dùng & quyền · chỉ Admin', title: 'Người dùng & quyền' }}
      actions={
        <Button icon={<UserPlus size={16} />} disabled={!res.data} onClick={() => setDialog({ kind: 'add' })}>
          Thêm người dùng
        </Button>
      }
    >
      <ErrorBanner error={res.error ?? actionError} />
      <NetProgress op="admin.users-load" active={res.loading && !res.data} label="Đang tải danh sách người dùng" className="self-center" />
      {!res.error && (
        <div className="flex min-h-0 flex-1 gap-[16px]">
          <div className="flex min-w-0 flex-1 flex-col gap-[16px]">
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(u) => u.id}
              dimRow={(u) => u.status === 'locked'}
              rowClass={(u) => (menuFor === u.id || activeRow === u.id ? 'bg-table-head' : flash === u.id ? 'bg-[#F1FAF4]' : undefined)}
              title="Người dùng & quyền"
              subtitle={!res.data && res.loading ? 'Đang tải...' : `${users.length} tài khoản · dùng chung cho mọi app`}
              actions={
                <>
                  <FilterMenu icon={<Shield size={13} />} label="Vai:" valueLabel={ROLE_FILTERS.find((o) => o.key === role)!.label} options={ROLE_FILTERS} value={role} onChange={setRole} />
                  <FilterMenu icon={<CircleDot size={13} />} label="Trạng thái:" valueLabel={STATUS_OPTIONS.find((o) => o.key === status)!.label} options={STATUS_OPTIONS} value={status} onChange={setStatus} />
                </>
              }
              footer={
                <>
                  <Table2 size={13} className="shrink-0 text-ai" />
                  <span className="min-w-0 flex-1 truncate text-text-2">{IS_HSDESK ? 'Quyền thao tác và quyền duyệt đặt theo vai, áp cho mọi app. Không có Xoá, dùng Khoá.' : 'Quyền thao tác đặt theo vai, áp cho mọi app. Không có Xoá, dùng Khoá.'}</span>
                  <button type="button" onClick={() => navigate(`${base}/bang-quyen`)} className="font-semibold whitespace-nowrap text-ai">
                    Mở Bảng quyền theo vai →
                  </button>
                </>
              }
            />
            {!onWeb && IS_HSDESK && <AiConsentCard className="min-h-0 flex-1" />}
          </div>
          {!onWeb && <AiServicePanel />}
        </div>
      )}

      {dialogs}
      {toastEl}
    </AdminPage>
  );
}
