import { useCallback, useEffect, useState } from 'react';
import { CloudDownload, FileDown, RefreshCw, TriangleAlert, X } from 'lucide-react';
import { platform, isDesktop, type SyncIssue } from '../platform';
import { errorText } from '../lib/session';
import { useAction } from '../lib/use-action';
import { useDriveSync } from '../sync/drive-sync';
import { driveApi, type DriveConflict, type DriveNotice, type DriveStatus } from '../sync/drive-api';
import { driveCopy, driveErrorText, syncView, vnClock } from '../sync/sync-view';
import { Banner, Button } from './ui';
import { cx } from './ui/cx';
import { NetProgress } from './NetProgress';

const KIND: Record<string, string> = {
  'sheet.write_card': 'Ghi thẻ hàng lên Sheet Vipo',
  'sheet.append_teach': 'Ghi Sổ dạy AI',
};

export type SyncPanelBusy = '' | 'pull' | 'sync' | 'export';

export interface SyncPanelViewProps {
  status: DriveStatus;
  conflicts: DriveConflict[];
  notices: DriveNotice[];
  /** Mục lỗi của hàng đợi cũ (ghi Sheet Vipo): vẫn chọn bản như trước. */
  issues?: SyncIssue[];
  /** Có dữ liệu trên máy (desktop): Kéo ngay, Đồng bộ ngay, xung đột, nhật ký. PWA chỉ xem trạng thái. */
  local: boolean;
  busy?: SyncPanelBusy;
  message?: string;
  error?: string;
  onPull?: () => void;
  onSync?: () => void;
  onExport?: () => void;
  onOpenConflict?: (id: string) => void;
  onSeeNotice?: (id: string) => void;
  /** Bỏ hết thông báo một lần (hiện khi có từ 2 thông báo). */
  onSeeAllNotices?: () => void;
  onResolveIssue?: (id: string, keepMine: boolean) => void;
  onClose?: () => void;
  className?: string;
}

const row = 'flex items-center justify-between gap-[12px] py-[7px] text-[12.5px]/[16px] shadow-[inset_0_-1px_0_var(--color-divider)] last:shadow-none';

/** Bảng đồng bộ (mở từ thanh trạng thái): số chờ, lần đồng bộ cuối, xung đột còn mở, thông báo, Kéo ngay, Đồng bộ ngay, xuất nhật ký. */
export function SyncPanelView(p: SyncPanelViewProps) {
  const v = syncView(p.status);
  const s = p.status;
  return (
    <section role="dialog" aria-label="Đồng bộ Drive công ty" className={cx('stroke-in flex w-[380px] max-w-[calc(100vw-24px)] flex-col gap-[12px] rounded-[12px] bg-surface p-[16px] leading-[normal] text-text shadow-popup', p.className)}>
      <header className="flex items-start gap-[10px]">
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <h2 className="text-[14px]/[18px] font-bold">{v.text}</h2>
          {v.detail && <p className="text-[12px]/[17px] text-text-2">{v.detail}</p>}
        </div>
        {p.onClose && (
          <button type="button" aria-label="Đóng" onClick={p.onClose} className="text-text-3">
            <X size={16} />
          </button>
        )}
      </header>

      {p.local && (
        <dl className="flex flex-col">
          <div className={row}>
            <dt className="text-text-3">Chờ đồng bộ</dt>
            <dd className="font-semibold">{s.pending}</dd>
          </div>
          <div className={row}>
            <dt className="text-text-3">Lần đồng bộ cuối</dt>
            <dd className="font-semibold">{s.lastSyncAt ? vnClock(s.lastSyncAt) : '—'}</dd>
          </div>
        </dl>
      )}

      {p.conflicts.length > 0 && (
        <div className="flex flex-col gap-[6px]">
          <h3 className="text-[11px]/[14px] font-bold tracking-[0.5px] text-text-3 uppercase">{driveCopy('sync_conflicts_open', { n: p.conflicts.length })}</h3>
          <ul className="flex flex-col gap-[6px]">
            {p.conflicts.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => p.onOpenConflict?.(c.id)} className="stroke-in flex w-full items-center gap-[8px] rounded-[8px] px-[10px] py-[8px] text-left hover:bg-bg">
                  <span className="rounded-[4px] bg-blue-soft px-[6px] py-[2px] text-[10px]/[13px] font-bold whitespace-nowrap text-blue">chờ giải quyết xung đột</span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px]/[16px] font-semibold">{c.itemId}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {p.notices.length > 1 && p.onSeeAllNotices && (
        <div className="flex items-center justify-between gap-[8px]">
          <span className="text-[12px]/[16px] text-text-3">{p.notices.length} thông báo</span>
          <Button size="xs" variant="secondary" onClick={p.onSeeAllNotices}>
            Đã xem tất cả
          </Button>
        </div>
      )}

      {p.notices.map((n) => (
        <Banner key={n.id} tone="blue">
          {driveCopy(n.messageCode, { ...n.params, at: n.params.at ?? n.createdAt })}{' '}
          {p.onSeeNotice && (
            <button type="button" className="font-semibold underline" onClick={() => p.onSeeNotice?.(n.id)}>
              Đã xem
            </button>
          )}
        </Banner>
      ))}

      {!!p.issues?.length && (
        <ul className="flex flex-col gap-[6px]">
          {p.issues.map((i) => (
            <li key={i.id} className="flex flex-col gap-[6px] rounded-[8px] bg-red-soft p-[10px] text-[12px]/[16px]">
              <span className="flex items-center gap-[6px] font-semibold text-red">
                <TriangleAlert size={13} /> {KIND[i.kind] ?? i.kind} · <span className="font-mono">{i.entity.replace('req:', '')}</span>
              </span>
              {i.lastError && <span className="text-text-2">{errorText(i.lastError)}</span>}
              <span className="flex gap-[6px]">
                <Button size="xs" variant="secondary" disabled={!!p.busy} onClick={() => p.onResolveIssue?.(i.id, true)}>
                  Ghi bản của tôi
                </Button>
                <Button size="xs" variant="ghost" disabled={!!p.busy} onClick={() => p.onResolveIssue?.(i.id, false)}>
                  Bỏ, lấy bản trên Sheet
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {p.error && <Banner tone="red">{p.error}</Banner>}
      {p.message && <Banner tone="green">{p.message}</Banner>}

      {/* Luôn gắn (chỉ đổi active) để lần chạy xong được ghi vào lịch sử ước lượng thời gian. */}
      <NetProgress op="drive.pull" active={!!p.local && p.busy === 'pull'} label="Đang kéo dữ liệu từ Drive" />
      <NetProgress op="drive.sync" active={!!p.local && p.busy === 'sync'} label="Đang đồng bộ với Drive" />

      {p.local && (
        <footer className="flex flex-wrap gap-[8px]">
          <Button size="dialog" variant="secondary" icon={<CloudDownload size={14} />} disabled={!!p.busy || s.state === 'not_connected'} loading={p.busy === 'pull'} onClick={p.onPull}>
            Kéo ngay
          </Button>
          <Button size="dialog" icon={<RefreshCw size={14} />} disabled={!!p.busy} loading={p.busy === 'sync'} onClick={p.onSync}>
            Đồng bộ ngay
          </Button>
          <Button size="dialog" variant="ghost" icon={<FileDown size={14} />} disabled={!!p.busy} loading={p.busy === 'export'} onClick={p.onExport}>
            {p.busy === 'export' ? 'Đang xuất…' : 'Xuất nhật ký đồng bộ'}
          </Button>
        </footer>
      )}
    </section>
  );
}

/** Bảng đồng bộ gắn dữ liệu thật. `className` đặt vị trí (popover dưới thanh trạng thái hoặc khối trong Cài đặt). */
export function SyncPanel({ className, onClose }: { className?: string; onClose?: () => void }) {
  const sync = useDriveSync();
  const [issues, setIssues] = useState<SyncIssue[]>([]);
  const [busy, setBusy] = useState<SyncPanelBusy>('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const loadIssues = useCallback(() => {
    if (!isDesktop || !platform.listSyncIssues) return;
    // Xung đột Drive đi qua hộp chọn riêng; danh sách cũ chỉ còn việc ghi Sheet Vipo.
    platform.listSyncIssues().then((l) => setIssues(l.filter((i) => !i.kind.startsWith('drive.'))), (e) => setError(errorText(e)));
  }, []);
  useEffect(loadIssues, [loadIssues, sync?.status?.pending]);

  // Kéo, Đồng bộ, Xuất nhật ký, chọn bản cho mục lỗi: một việc một lúc, lần bấm tiếp khi đang chạy bị bỏ qua.
  const [run] = useAction(async (kind: Exclude<SyncPanelBusy, ''>, fn: () => Promise<unknown>, done?: (r: unknown) => string) => {
    setBusy(kind);
    setError('');
    setMessage('');
    try {
      const r = await fn();
      if (done) setMessage(done(r));
      await sync?.reload();
      loadIssues();
    } catch (e) {
      setError(driveErrorText(e));
    } finally {
      setBusy('');
    }
  });

  if (!sync?.status) return null;

  return (
    <SyncPanelView
      className={className}
      status={sync.status}
      conflicts={sync.conflicts}
      notices={sync.notices}
      issues={issues}
      local={isDesktop}
      busy={busy}
      error={error}
      message={message}
      onClose={onClose}
      onPull={() => void run('pull', driveApi.pullNow)}
      onSync={() => void run('sync', driveApi.syncNow)}
      onExport={() => void run('export', driveApi.exportSyncLog, (path) => (path ? `Đã lưu nhật ký: ${String(path)}` : ''))}
      onOpenConflict={(id) => {
        onClose?.();
        sync.openConflict(id);
      }}
      onSeeNotice={(id) => void sync.seeNotice(id).catch((e) => setError(errorText(e)))}
      onSeeAllNotices={() => {
        // Lần lượt từng thông báo (mỗi lần ghi lại danh sách), lỗi dừng ở thông báo đó.
        void (async () => {
          try {
            for (const n of sync.notices) await sync.seeNotice(n.id);
          } catch (e) {
            setError(errorText(e));
          }
        })();
      }}
      onResolveIssue={(id, keepMine) => void run('sync', () => platform.resolveSyncIssue!(id, keepMine))}
    />
  );
}
