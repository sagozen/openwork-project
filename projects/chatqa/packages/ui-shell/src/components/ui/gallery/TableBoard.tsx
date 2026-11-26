import { ChevronDown, CircleDot, Ellipsis, KeyRound, Lock, Monitor, Pencil, Shield, Table2 } from 'lucide-react';
import { AppChip, DataTable, Menu, MenuItem, MenuNote, OnlyRequestTag, RoleChip, StatusDot, Tag, Avatar, type Column } from '..';
import { DEMO_USERS, type DemoUser } from './data';

function Filter({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <span className="flex h-[28px] shrink-0 items-center gap-[6px] stroke-in rounded-[7px] bg-surface px-[10px] text-[11px]/[14px]">
      <span className="text-text-3">{icon}</span>
      <span className="text-text-3">{label}</span>
      <span className="font-semibold text-text">{value}</span>
      <ChevronDown size={12} className="text-text-3" />
    </span>
  );
}

const COLUMNS: Column<DemoUser>[] = [
  {
    key: 'who',
    header: 'TÊN HIỂN THỊ',
    render: (u) => (
      <div className="flex items-center gap-[8px]">
        <Avatar initials={u.initials} tone={u.tone} size={26} />
        <div className="flex flex-col gap-[3px]">
          <span className="text-[12px]/[15px] font-semibold whitespace-nowrap text-text">{u.name}</span>
          {u.tag && (
            <span className="flex">
              <Tag kind={u.tag} />
            </span>
          )}
        </div>
      </div>
    ),
  },
  { key: 'username', header: 'TÊN ĐĂNG NHẬP', width: 84, render: (u) => <span className="block font-mono text-[10.5px]/[14px] text-text-2">{u.username}</span> },
  { key: 'role', header: 'VAI', width: 72, render: (u) => <RoleChip role={u.role} /> },
  {
    key: 'apps',
    header: 'APP ĐƯỢC CẤP',
    width: 100,
    render: (u) =>
      u.apps ? (
        <div className="flex items-center gap-[3px]">
          {u.apps.map((on, i) => (
            <AppChip key={i} no={`0${i + 1}`} granted={on} />
          ))}
        </div>
      ) : (
        <OnlyRequestTag>Gửi yêu cầu</OnlyRequestTag>
      ),
  },
  { key: 'status', header: 'TRẠNG THÁI', width: 80, render: (u) => <StatusDot tone={u.status.tone}>{u.status.label}</StatusDot> },
  {
    key: 'machine',
    header: 'MÁY GẦN NHẤT',
    width: 84,
    render: (u) => (
      <span className="flex items-center gap-[4px] text-[10px]/[13px] text-text-2">
        <Monitor size={11} className="shrink-0 text-text-3" />
        {u.machine}
      </span>
    ),
  },
  { key: 'last', header: 'ĐĂNG NHẬP CUỐI', width: 90, render: (u) => <span className="block text-[10.5px]/[13px] text-text-2">{u.lastLogin}</span> },
  { key: 'act', header: '', width: 20, render: (u) => <Ellipsis size={16} className={u.id === 'tranlan' ? 'mx-auto text-text' : 'mx-auto text-text-3'} /> },
];

/** Thẻ bảng người dùng (D7XS6: 772×415 kèm menu "..." mở ở dòng Trần Lan; ULXup bản web: 1148 rộng, không mở menu). */
export function TableBoard({ width = 772, menu = true }: { width?: number; menu?: boolean }) {
  return (
    <div className="relative h-[415px]" style={{ width }}>
      <DataTable
        className="h-full"
        columns={COLUMNS}
        rows={DEMO_USERS}
        rowKey={(u) => u.id}
        dimRow={(u) => u.tag === 'locked'}
        title="Người dùng & quyền"
        subtitle="7 tài khoản · dùng chung cho mọi app"
        actions={
          <>
            <Filter icon={<Shield size={13} />} label="Vai:" value="Tất cả" />
            <Filter icon={<CircleDot size={13} />} label="Trạng thái:" value="Tất cả" />
          </>
        }
        footer={
          <>
            <Table2 size={13} className="shrink-0 text-ai" />
            <span className="min-w-0 flex-1 truncate text-text-2">Quyền thao tác và quyền duyệt đặt theo vai, áp cho mọi app. Không có Xoá, dùng Khoá.</span>
            <span className="font-semibold whitespace-nowrap text-ai">Mở Bảng quyền theo vai →</span>
          </>
        }
      />
      {menu && (
      <div className="absolute top-[201px] left-[540px]">
        <Menu>
          <MenuItem active icon={<Pencil size={14} />}>Sửa</MenuItem>
          <MenuItem icon={<KeyRound size={14} />}>Đặt lại mật khẩu</MenuItem>
          <MenuItem tone="danger" icon={<Lock size={14} />}>Khoá tài khoản</MenuItem>
          <MenuNote>Không có Xoá. Tài khoản đã khoá vẫn giữ lịch sử.</MenuNote>
        </Menu>
      </div>
      )}
    </div>
  );
}

