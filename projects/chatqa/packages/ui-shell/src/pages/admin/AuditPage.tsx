import { useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, Eye, KeyRound, ListFilter, Monitor, Table2, User } from 'lucide-react';
import { Tag } from '../../components/ui';
import { cx } from '../../components/ui/cx';
import { adminApi, type AdminDevice, type AdminUser, type AuditPage as AuditData } from './admin-api';
import { toAdminError } from './admin-error';
import { ACTION_TYPES, AUDIT_PAGE_SIZE, buildAuditQuery, cursorQueryFor, DATE_RANGES, DEFAULT_FILTERS, makeLookups, pageCount, pageWindow, presentAudit, rangeLabel, rangeText, type AuditFilters, type ObjectIcon } from './audit-format';
import { usePhoneLayout } from './admin-context';
import { AdminPage, ErrorBanner, FilterMenu } from './parts';
import { AuditPhone } from './phone/AuditPhone';
import { PhoneAdminPage } from './phone/parts';

const HEAD = 'text-[9px]/[11px] font-bold tracking-[0.5px] text-text-3';
const OBJECT_ICON: Record<ObjectIcon, React.ReactNode> = {
  user: <User size={12} />,
  device: <Monitor size={12} />,
  matrix: <Table2 size={12} />,
  license: <KeyRound size={12} />,
};

export default function AuditPage() {
  const phone = usePhoneLayout();
  const [filters, setFilters] = useState<AuditFilters>(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AuditData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [people, setPeople] = useState<{ users: AdminUser[]; devices: AdminDevice[] }>({ users: [], devices: [] });
  const cursors = useRef(new Map<number, number | undefined>([[1, undefined]]));
  const nowSec = Math.floor(Date.now() / 1000);

  // Danh sách người và máy: dùng cho ô lọc "Người" và để ghi tên người / máy thật ở cột Đối tượng.
  useEffect(() => {
    void Promise.all([adminApi.users().catch(() => [] as AdminUser[]), adminApi.devices().catch(() => [] as AdminDevice[])]).then(([users, devices]) => setPeople({ users, devices }));
  }, []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    (async () => {
      try {
        const now = Math.floor(Date.now() / 1000);
        if (!cursors.current.has(page)) {
          const prev = await adminApi.audit(cursorQueryFor(page, filters, now));
          // Lượt tải cũ (đã đổi bộ lọc / trang) không được ghi con trỏ vào bảng của bộ lọc mới.
          if (!live) return;
          cursors.current.set(page, prev.next ?? undefined);
        }
        const res = await adminApi.audit(buildAuditQuery(filters, now, cursors.current.get(page)));
        if (live) {
          setData(res);
          setError(null);
        }
      } catch (e) {
        if (live) {
          setData(null);
          setError(toAdminError(e));
        }
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [filters, page]);

  const change = (patch: Partial<AuditFilters>) => {
    cursors.current = new Map([[1, undefined]]);
    setPage(1);
    setFilters((f) => ({ ...f, ...patch }));
  };

  const lookups = useMemo(() => makeLookups(people.users, people.devices), [people]);
  const rows = useMemo(() => (data?.items ?? []).map((it) => presentAudit(it, lookups)), [data, lookups]);
  const total = data?.total ?? 0;
  const pages = pageCount(total);
  const personOptions = [{ key: '', label: 'Tất cả' }, ...people.users.map((u) => ({ key: u.id, label: u.display_name }))];
  const actionOptions = [{ key: '', label: 'Tất cả' }, ...ACTION_TYPES];

  if (phone) {
    return (
      <PhoneAdminPage title="Nhật ký quản trị" error={error}>
        {!error && (
          <AuditPhone
            rows={rows}
            persons={personOptions}
            actions={actionOptions}
            ranges={DATE_RANGES}
            user={filters.user}
            action={filters.action}
            range={filters.range}
            rangeLabel={rangeLabel(filters.range, nowSec).replace(/\/20\d\d/g, '')}
            onUser={(user) => change({ user })}
            onAction={(action) => change({ action })}
            onRange={(range) => change({ range: range as AuditFilters['range'] })}
            page={page}
            pages={pages}
            onPage={setPage}
            loading={loading}
          />
        )}
      </PhoneAdminPage>
    );
  }

  return (
    <AdminPage tab="audit" crumb="Cài đặt › Nhật ký quản trị · chỉ xem" title="Nhật ký quản trị">
      <div className="flex w-full items-center gap-[10px]">
        <FilterMenu size="md" align="left" icon={<User size={14} />} label="Người:" valueLabel={personOptions.find((o) => o.key === filters.user)?.label ?? 'Tất cả'} options={personOptions} value={filters.user} onChange={(user) => change({ user })} />
        <FilterMenu size="md" align="left" icon={<ListFilter size={14} />} label="Loại thao tác:" valueLabel={actionOptions.find((o) => o.key === filters.action)?.label ?? 'Tất cả'} options={actionOptions} value={filters.action} onChange={(action) => change({ action })} />
        <FilterMenu size="md" align="left" icon={<Calendar size={14} />} label="Khoảng ngày:" valueLabel={rangeLabel(filters.range, nowSec)} options={DATE_RANGES} value={filters.range} onChange={(range) => change({ range })} />
        <span className="h-px flex-1" />
        <span className="flex items-center gap-[6px] text-[12px] whitespace-nowrap text-text-3">
          <Eye size={13} />
          Chỉ xem · {total} mục · không sửa, không xoá
        </span>
      </div>
      <ErrorBanner error={error} />
      {!error && (
        <>
          <div aria-busy={loading || undefined} className={cx('stroke-in flex w-full flex-col overflow-hidden rounded-[12px] bg-surface', loading && data && 'opacity-60')}>
            <div className="flex h-[29px] items-center gap-[14px] bg-table-head px-[18px] py-[9px] shadow-[inset_0_-1px_0_var(--color-border)]">
              <span className={cx('w-[104px] shrink-0', HEAD)}>THỜI ĐIỂM</span>
              <span className={cx('w-[196px] shrink-0', HEAD)}>NGƯỜI LÀM</span>
              <span className={cx('w-[170px] shrink-0', HEAD)}>THAO TÁC</span>
              <span className={cx('w-[160px] shrink-0', HEAD)}>ĐỐI TƯỢNG</span>
              <span className={cx('min-w-0 flex-1', HEAD)}>TRƯỚC</span>
              <span className={cx('min-w-0 flex-1', HEAD)}>SAU</span>
            </div>
            {rows.map((r) => (
              <div key={r.id} className="flex items-center gap-[14px] px-[18px] py-[9px] shadow-[inset_0_-1px_0_var(--color-divider)]">
                <span className="w-[104px] shrink-0 font-mono text-[11.5px] whitespace-nowrap text-text-2">{r.time}</span>
                <div className="flex w-[196px] shrink-0 flex-col items-start gap-[3px]">
                  <span className="text-[12.5px] whitespace-nowrap text-text">{r.actor.name}</span>
                  {r.actor.deployer && <Tag kind="deployer" />}
                  {r.actor.locked && !r.actor.deployer && <Tag kind="locked" />}
                  {r.actor.outside && <OutsideTag />}
                </div>
                <span className="w-[170px] shrink-0 text-[12.5px] font-semibold text-text">{r.action}</span>
                <span className="flex w-[160px] shrink-0 items-center gap-[6px] text-text-2">
                  <span className="flex shrink-0 text-text-3">{OBJECT_ICON[r.object.icon]}</span>
                  <span className="min-w-0 truncate font-mono text-[11.5px] whitespace-nowrap">{r.object.text}</span>
                </span>
                <span className="min-w-0 flex-1 text-[12px] text-text-3">{r.before}</span>
                <span className="min-w-0 flex-1 text-[12px] text-text">{r.after}</span>
              </div>
            ))}
            {!data && loading && <p className="px-[18px] py-[18px] text-[12px] text-text-3">Đang tải...</p>}
            {!rows.length && data && <p className="px-[18px] py-[18px] text-[12px] text-text-3">Không có thao tác nào khớp bộ lọc.</p>}
          </div>
          <div className="flex w-full items-center justify-between">
            <span className="text-[12px] whitespace-nowrap text-text-3">{rangeText(page, rows.length, total, AUDIT_PAGE_SIZE)}</span>
            <div className="flex gap-[6px]">
              <PageButton disabled={page <= 1} onClick={() => setPage(page - 1)}>
                ‹
              </PageButton>
              {pageWindow(page, pages).map((n) => (
                <PageButton key={n} active={n === page} onClick={() => setPage(n)}>
                  {n}
                </PageButton>
              ))}
              <PageButton disabled={page >= pages} onClick={() => setPage(page + 1)}>
                ›
              </PageButton>
            </div>
          </div>
        </>
      )}
    </AdminPage>
  );
}

/** Thay đổi ngoài app do Bên triển khai làm (không có tài khoản trong app). */
function OutsideTag() {
  return <span className="inline-flex h-[13px] items-center gap-[3px] rounded-[4px] bg-text px-[5px] py-px text-[9px]/[11px] font-semibold whitespace-nowrap text-white">Ngoài app</span>;
}

function PageButton({ children, active, disabled, onClick }: { children: React.ReactNode; active?: boolean; disabled?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={cx('flex h-[28px] w-[28px] items-center justify-center rounded-[6px] text-[12px] font-semibold', active ? 'bg-text text-white' : 'stroke-in bg-surface text-text-2 disabled:opacity-50')}
    >
      {children}
    </button>
  );
}
