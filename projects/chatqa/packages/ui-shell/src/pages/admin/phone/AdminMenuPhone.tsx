import type { ReactNode } from 'react';
import { ChartColumn, ChevronRight, Clock, HardDrive, Monitor, ScrollText, Table2, Users } from 'lucide-react';
import { useNavigate } from 'react-router';
import { platform } from '../../../platform';
import { ROLES } from '../../../platform/roles';
import { IS_HSDESK } from '../../../lib/catalog';
import { WebScreen } from '../../../components/shell';
import { REPORT_PATH } from '../../../components/shell/web-chrome';
import { adminApi } from '../admin-api';
import { adminTabOn } from '../admin-tabs';
import { TAB_PATHS, useAdmin, type TabKey } from '../admin-context';
import { startOfDay, vnTime } from '../format';
import { visibleUsers } from '../users-view';
import { usedText } from '../devices-view';
import { useResource } from '../use-resource';

/** Đầu tháng theo giờ Việt Nam (giây unix): cho dòng "N mục tháng này" của nhật ký. */
const monthStart = (nowSec: number) => startOfDay(nowSec) - (Number(vnTime(nowSec).d) - 1) * 86400;

/** Mỗi dòng đọc số liệu riêng; lỗi một dòng (mất mạng, API chưa có) chỉ làm dòng đó trống, không hỏng cả menu. */
const safe = <T,>(p: Promise<T>) => p.then((v) => v, () => null);

function Row({ icon, label, desc, badge, onClick }: { icon: ReactNode; label: string; desc?: string; badge?: number; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-[12px] px-[14px] py-[13px] text-left shadow-[inset_0_-1px_0_var(--color-divider)] last:shadow-none">
      <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-chip-neutral text-text-2">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="text-[14px] font-semibold text-text">{label}</span>
        {desc && <span className="text-[12px] text-text-3">{desc}</span>}
      </span>
      {!!badge && <span className="rounded-[9px] bg-amber-soft px-[7px] py-px text-[11px] font-bold text-amber">{badge}</span>}
      <ChevronRight size={16} className="shrink-0 text-text-3" />
    </button>
  );
}

/** Menu Quản trị trên điện thoại (WsSHs): thay cho sidebar. */
export default function AdminMenuPhone() {
  const navigate = useNavigate();
  const { base, pending } = useAdmin();
  const now = Math.floor(Date.now() / 1000);
  const info = useResource(async () => {
    const [users, license, audit, google] = await Promise.all([
      safe(adminApi.users()),
      safe(adminApi.license()),
      safe(adminApi.audit({ from: monthStart(now), limit: 1 })),
      adminTabOn('drive') ? safe(platform.api<{ connected: boolean }>('/v1/google/status')) : Promise.resolve(null),
    ]);
    return { users: users ? visibleUsers(users).length : undefined, license, audit: audit?.total, drive: google ? (google.connected ? 'Đã kết nối' : 'Chưa kết nối') : undefined };
  });
  const d = info.data;
  const go = (k: TabKey) => () => navigate(`${base}/${TAB_PATHS[k]}`);
  return (
    <WebScreen phone={{ title: 'Quản trị', menu: true, padded: false, bodyClass: 'gap-[14px] p-[16px]' }}>
      <h2 className="text-[11px] font-bold tracking-[1px] text-text-3">QUẢN TRỊ · CHỈ ADMIN</h2>
      <nav aria-label="Quản trị" className="stroke-in flex w-full flex-col rounded-[12px] bg-surface leading-[normal]">
        <Row icon={<Users size={17} />} label="Người dùng & quyền" desc={d?.users !== undefined ? `${d.users} tài khoản` : undefined} onClick={go('users')} />
        <Row icon={<Table2 size={17} />} label="Bảng quyền theo vai" desc={`${ROLES.filter((r) => r.code !== 'vipo').length} vai`} onClick={go('matrix')} />
        <Row icon={<Monitor size={17} />} label="Máy & bản quyền" desc={d?.license ? usedText(d.license) : undefined} onClick={go('devices')} />
        <Row icon={<ScrollText size={17} />} label="Nhật ký quản trị" desc={d?.audit !== undefined ? `${d.audit} mục tháng này` : undefined} onClick={go('audit')} />
        {adminTabOn('pending') && <Row icon={<Clock size={17} />} label="Chờ công nhận" desc={pending !== null ? `${pending} thao tác` : undefined} badge={pending ?? 0} onClick={go('pending')} />}
        {adminTabOn('drive') && <Row icon={<HardDrive size={17} />} label="Kết nối Drive" desc={d?.drive} onClick={go('drive')} />}
      </nav>
      <button type="button" onClick={() => navigate(REPORT_PATH)} className="stroke-in flex w-full items-center gap-[12px] rounded-[12px] bg-surface px-[14px] py-[13px] text-left leading-[normal]">
        <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-accent-soft text-accent">
          <ChartColumn size={17} />
        </span>
        <span className="min-w-0 flex-1 text-[14px] font-semibold">Báo cáo (chỉ xem)</span>
        <ChevronRight size={16} className="shrink-0 text-text-3" />
      </button>
      <p className="text-[12px] text-text-3">{IS_HSDESK ? 'Duyệt và Yêu cầu sửa làm trên app Windows ở v1.' : ''}</p>
    </WebScreen>
  );
}
