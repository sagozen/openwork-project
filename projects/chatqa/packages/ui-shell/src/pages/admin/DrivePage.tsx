// Kết nối Google Drive (SNoTG web, VJX8o điện thoại; cũng có trong khu quản trị Windows): chỉ Admin (quyền admin.drive).
// Dựng lại phần "Google Drive" của SettingsPage cũ. Trường chi tiết (người kết nối, dung lượng, lần đồng bộ, các mục kiểm tra) do tính năng
// drive-backup-sync cung cấp qua /v1/google/status; thiếu thì dòng đó không hiện, không có số liệu giả.
import { useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { Check, HardDrive, RefreshCw, Repeat, TriangleAlert, Unplug } from 'lucide-react';
import { platform, isDesktop } from '../../platform';
import { DeviceSyncTable } from '../StoragePage';
import { Button, Dialog } from '../../components/ui';
import { NetProgress } from '../../components/NetProgress';
import { cx } from '../../components/ui/cx';
import { fmtDayTime, fmtShort } from './format';
import { toAdminError } from './admin-error';
import { usePhoneLayout } from './admin-context';
import { AdminPage, ErrorBanner } from './parts';
import { PhoneAdminPage, PhoneCard } from './phone/parts';
import { useResource } from './use-resource';

interface DriveStatus {
  connected: boolean;
  email?: string;
  root_folder_id?: string | null;
  vipo_sheet_id?: string | null;
  connected_by?: string;
  connected_at?: number;
  /** Tên mới của Worker (/v1/google/status). */
  connectedBy?: string | null;
  connectedAt?: number | null;
  folder_path?: string;
  storage?: { used_gb: number; free_gb: number };
  last_sync?: { at: number; device: string };
  checks?: { ok: boolean; title: string; desc: string }[];
}

const gb = (n: number) => `${n.toLocaleString('vi-VN')} GB`;
const NOTE = 'Ngắt kết nối thì mọi máy ngừng đồng bộ, dữ liệu vẫn giữ trên từng máy.';
const NOTE_LONG = `${NOTE} Kết nối lại cùng thư mục để các máy đồng bộ tiếp.`;

function Notice({ children, small }: { children: ReactNode; small?: boolean }) {
  return (
    <div className={cx('flex items-start gap-[10px] rounded-[10px] bg-amber-soft [--stroke-c:var(--color-line-amber)] stroke-in', small ? 'gap-[8px] p-[12px]' : 'px-[14px] py-[12px]')}>
      <TriangleAlert size={small ? 14 : 15} className="mt-[2px] shrink-0 text-amber" />
      <p className={cx('min-w-0 flex-1 text-[#7C3A06]', small ? 'text-[12px]/[17px]' : 'text-[12.5px]/[18px]')}>{children}</p>
    </div>
  );
}

function useDrive() {
  const [params] = useSearchParams();
  const res = useResource(() => platform.api<DriveStatus>('/v1/google/status'));
  // Thao tác đang chạy. Kết nối giữ cờ tới khi trình duyệt chuyển sang Google (không nhả khi thành công).
  const [pending, setPending] = useState<'connect' | 'disconnect' | null>(null);
  const lock = useRef(false);
  const [error, setError] = useState<unknown>(params.get('google') && params.get('google') !== 'ok' ? { code: 'error' } : null);
  const [confirm, setConfirm] = useState(false);

  async function connect() {
    if (lock.current) return;
    lock.current = true;
    setPending('connect');
    setError(null);
    try {
      const { url } = await platform.api<{ url: string }>('/v1/google/connect-url', { method: 'POST' });
      window.location.href = url;
    } catch (e) {
      setError(toAdminError(e));
      lock.current = false;
      setPending(null);
    }
  }
  async function disconnect() {
    setConfirm(false);
    if (lock.current) return;
    lock.current = true;
    setPending('disconnect');
    setError(null);
    try {
      await platform.api('/v1/google', { method: 'DELETE' });
      await res.reload();
    } catch (e) {
      setError(toAdminError(e));
    } finally {
      lock.current = false;
      setPending(null);
    }
  }
  return { res, busy: pending !== null, pending, error, confirm, setConfirm, connect, disconnect };
}

function DisconnectDialog({ onCancel, onOk }: { onCancel: () => void; onOk: () => void }) {
  return (
    <Dialog
      variant="compact"
      tone="amber"
      icon={<Unplug size={18} />}
      title="Ngắt kết nối Google Drive?"
      actions={
        <>
          <Button variant="secondary" size="dialog" onClick={onCancel}>
            Hủy
          </Button>
          <Button variant="danger" size="dialog" onClick={onOk}>
            Ngắt kết nối
          </Button>
        </>
      }
    >
      {NOTE}
    </Dialog>
  );
}

export default function DrivePage() {
  const phone = usePhoneLayout();
  const d = useDrive();
  const s = d.res.data;
  const now = Math.floor(Date.now() / 1000);
  const err = d.res.error ?? d.error;

  const status = s?.connected ? (
    <span className="flex items-center gap-[6px] text-[12px]/[15px] font-bold text-green">
      <span className="h-[8px] w-[8px] rounded-full bg-current" />
      Đã kết nối
    </span>
  ) : (
    <span className="text-[12px]/[15px] font-bold text-text-3">Chưa kết nối</span>
  );
  const folder = s?.folder_path;
  const rows: { key: string; value: string; mono?: boolean }[] = [];
  if (folder) rows.push({ key: 'Thư mục gốc', value: phone ? folder.replace(/^Drive của tôi \/ /, '') : folder, mono: !phone });
  if (s?.storage) rows.push({ key: 'Dung lượng', value: phone ? `${gb(s.storage.used_gb)} · còn ${gb(s.storage.free_gb)}` : `${gb(s.storage.used_gb)} đã dùng · còn ${gb(s.storage.free_gb)}` });
  if (s?.last_sync) rows.push({ key: 'Đồng bộ gần nhất', value: phone ? fmtDayTime(s.last_sync.at, now) : `${fmtDayTime(s.last_sync.at, now)} từ ${s.last_sync.device}` });

  const actions = s?.connected ? (
    <>
      <Button variant="secondary" size="dialog" className={phone ? 'flex-1' : undefined} icon={<Repeat size={phone ? 13 : 14} />} disabled={d.busy} loading={d.pending === 'connect'} onClick={() => void d.connect()}>
        {phone ? 'Đổi tài khoản' : 'Đổi tài khoản Drive'}
      </Button>
      <Button variant="danger" size="dialog" className={phone ? 'flex-1' : '[--stroke-c:var(--color-line-red)]'} icon={<Unplug size={phone ? 13 : 14} />} disabled={d.busy} loading={d.pending === 'disconnect'} onClick={() => d.setConfirm(true)}>
        {d.pending === 'disconnect' ? 'Đang ngắt…' : 'Ngắt kết nối'}
      </Button>
    </>
  ) : s ? (
    <Button size="dialog" loading={d.pending === 'connect'} disabled={d.busy} onClick={() => void d.connect()}>
      Kết nối Google Drive
    </Button>
  ) : null;

  const by = s?.connectedBy ?? s?.connected_by;
  const at = s?.connectedAt ?? s?.connected_at;
  // Web: phần chỉ đọc của Lưu trữ đám mây (cảnh báo Drive, đồng bộ từng máy). Windows xem ở mục Lưu trữ đám mây.
  const readOnlySync = !isDesktop && s?.connected && (
    <>
      <DeviceSyncTable compact={phone} />
    </>
  );

  const dialog = d.confirm && <DisconnectDialog onCancel={() => d.setConfirm(false)} onOk={() => void d.disconnect()} />;

  if (phone) {
    return (
      <PhoneAdminPage title="Kết nối Drive" error={err}>
        <NetProgress op="drive.google-status" active={!s && d.res.loading} label="Đang tải trạng thái kết nối Drive" className="self-center py-16" />
        {s && (
          <>
            <PhoneCard className="gap-[10px] p-[16px]">
              <div className="flex items-center gap-[12px]">
                <span className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-[12px] bg-green-soft text-green">
                  <HardDrive size={20} />
                </span>
                <div className="flex min-w-0 flex-col gap-[2px]">
                  <span className="text-[12px]/[15px] font-bold text-green">{s.connected ? 'Đã kết nối' : 'Chưa kết nối'}</span>
                  {s.email && <span className="truncate text-[15px]/[19px] font-bold">{s.email}</span>}
                </div>
              </div>
              {rows.map((r) => (
                <div key={r.key} className="flex flex-col gap-[2px] pt-[8px] shadow-[inset_0_1px_0_var(--color-divider)]">
                  <span className="text-[11.5px]/[15px] text-text-3">{r.key}</span>
                  <span className="text-[13px]/[17px] font-semibold">{r.value}</span>
                </div>
              ))}
            </PhoneCard>
            <div className="flex w-full gap-[8px]">{actions}</div>
            {s.connected && <Notice small>{NOTE}</Notice>}
            {readOnlySync}
          </>
        )}
        {dialog}
      </PhoneAdminPage>
    );
  }

  return (
    <AdminPage tab="drive" crumb="Cài đặt › Kết nối Drive · chỉ Admin" title="Kết nối Google Drive">
      <ErrorBanner error={err} />
      <NetProgress op="drive.google-status" active={!s && d.res.loading} label="Đang tải trạng thái kết nối Drive" className="self-center py-16" />
      {s && (
        <div className="flex min-h-0 w-full flex-1 items-start gap-[16px]">
          <div className="flex min-w-0 flex-1 flex-col gap-[16px]">
            <div className="stroke-in flex w-full flex-col rounded-[12px] bg-surface leading-[normal]">
              <div className="flex items-center gap-[16px] p-[22px] shadow-[inset_0_-1px_0_var(--color-border)]">
                <span className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-[14px] bg-green-soft text-green">
                  <HardDrive size={24} />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-[4px]">
                  {status}
                  {s.email && <span className="text-[17px]/[21px] font-bold">{s.email}</span>}
                  {s.connected && by && at && <span className="text-[12px]/[15px] text-text-3">Kết nối bởi {by} lúc {fmtShort(at)}</span>}
                </div>
                <div className="flex shrink-0 gap-[8px]">{actions}</div>
              </div>
              {rows.map((r) => (
                <div key={r.key} className="flex items-center px-[22px] py-[12px] shadow-[inset_0_-1px_0_var(--color-divider)] last:shadow-none">
                  <span className="w-[200px] shrink-0 text-[12.5px]/[16px] text-text-3">{r.key}</span>
                  <span className={cx('text-[12.5px]/[16px] font-semibold', r.mono && 'font-mono')}>{r.value}</span>
                </div>
              ))}
            </div>
            {s.connected && <Notice>{NOTE_LONG}</Notice>}
            {readOnlySync}
          </div>
          {s.checks && (
            <div className="stroke-in flex w-[380px] shrink-0 flex-col gap-[12px] rounded-[12px] bg-surface p-[20px] leading-[normal]">
              <h2 className="text-[14px]/[18px] font-bold">Kiểm tra kết nối</h2>
              {s.checks.map((c) => (
                <div key={c.title} className="flex gap-[10px]">
                  <span className={cx('flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full', c.ok ? 'bg-green-soft text-green' : 'bg-amber-soft text-amber')}>{c.ok ? <Check size={12} /> : <TriangleAlert size={12} />}</span>
                  <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
                    <span className="text-[12.5px]/[16px] font-semibold">{c.title}</span>
                    <span className="text-[11.5px]/[15px] text-text-3">{c.desc}</span>
                  </div>
                </div>
              ))}
              <Button variant="secondary" size="dialog" block icon={<RefreshCw size={13} />} loading={d.res.loading} onClick={() => void d.res.reload()}>
                Kiểm tra lại
              </Button>
              <NetProgress op="drive.google-status" active={d.res.loading} label="Đang kiểm tra kết nối Drive" />
            </div>
          )}
        </div>
      )}
      {dialog}
    </AdminPage>
  );
}
